/**
 * Exercises metadata-only secure-store recovery with deterministic command and
 * D-Bus boundaries. The suite covers selection, concurrent promotion, bounded
 * disappearance handling, and reset behavior without reading a host keychain.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type {
  SecureStoreGetResult,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import {
  enumerateLinuxSecretServiceMetadataForBus,
  type RuntimeSecretServiceBus,
} from "./platform-secure-store-node";
import {
  collectSecureStoreCleanupTargets,
  enumerateSecretServiceMetadata,
  MacOSKeychainMetadataParser,
  preferCurrentSecretAfterRecovery,
  promoteRecoveredMacOSSecret,
  readCurrentOrRecover,
  recoverCompatibleSecret,
  type SecretServiceMetadataBus,
  type SecureStoreMetadataRef,
  selectCompatibleCandidates,
  selectCompatibleCleanupTargets,
} from "./secure-store-compatibility";

const CURRENT_SERVICE = "ai.elizaos.agent.vault";
const CURRENT_TOKEN = "AbCdEf0123_-wXyZ";
const PRIOR_TOKEN = "ZyXwV_9876-abcDE";
const UNKNOWN_TOKEN = "0123456789abcdef";
const WALLET_KIND: SecureStoreSecretKind = "wallet.evm_private_key";
const STEWARD_KIND: SecureStoreSecretKind = "steward.agent_token";

function metadataRef(options: {
  sourceId: string;
  targetId?: string;
  service?: string;
  prefix?: string;
  token?: string;
  kind?: SecureStoreSecretKind;
}): SecureStoreMetadataRef {
  const service = options.service ?? "previous.service";
  const account = `${options.prefix ?? "previous"}-${options.token ?? CURRENT_TOKEN}:${options.kind ?? WALLET_KIND}`;
  return {
    sourceId: options.sourceId,
    targetId: options.targetId ?? `${service}\u0000${account}`,
    service,
    account,
  };
}

function currentAccount(kind = WALLET_KIND): string {
  return `eliza1-${CURRENT_TOKEN}:${kind}`;
}

describe("secure-store compatibility selection", () => {
  it("returns the exact current value without enumerating metadata", async () => {
    const recover = vi.fn<() => Promise<SecureStoreGetResult>>();
    const result = await readCurrentOrRecover({
      readCurrent: async () => ({ ok: true, value: "current-value" }),
      recover,
    });

    expect(result).toEqual({ ok: true, value: "current-value" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("does not recover after a denied current read", async () => {
    const recover = vi.fn<() => Promise<SecureStoreGetResult>>();
    const result = await readCurrentOrRecover({
      readCurrent: async () => ({ ok: false, reason: "denied" }),
      recover,
    });

    expect(result).toEqual({ ok: false, reason: "denied" });
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([
    WALLET_KIND,
    STEWARD_KIND,
  ])("selects a cross-service candidate for %s", (kind) => {
    const candidate = metadataRef({
      sourceId: "candidate",
      token: PRIOR_TOKEN,
      kind,
    });
    const selection = selectCompatibleCandidates(
      [candidate],
      CURRENT_SERVICE,
      currentAccount(kind),
      kind,
      new Set([CURRENT_TOKEN, PRIOR_TOKEN]),
    );

    expect(selection).toEqual({
      status: "selected",
      candidates: [candidate],
    });
  });

  it("rejects malformed accounts, other kinds, and unknown state tokens", () => {
    const refs: SecureStoreMetadataRef[] = [
      metadataRef({ sourceId: "unknown", token: UNKNOWN_TOKEN }),
      metadataRef({ sourceId: "other-kind", kind: STEWARD_KIND }),
      {
        sourceId: "malformed",
        targetId: "malformed",
        service: "previous.service",
        account: `missing-token:${WALLET_KIND}`,
      },
    ];

    expect(
      selectCompatibleCandidates(
        refs,
        CURRENT_SERVICE,
        currentAccount(),
        WALLET_KIND,
        new Set([CURRENT_TOKEN, PRIOR_TOKEN]),
      ),
    ).toEqual({ status: "not_found" });
  });

  it("rejects duplicate metadata that cannot be targeted independently", () => {
    const sharedTarget = "same-target";
    const selection = selectCompatibleCandidates(
      [
        metadataRef({ sourceId: "item-a", targetId: sharedTarget }),
        metadataRef({ sourceId: "item-b", targetId: sharedTarget }),
      ],
      CURRENT_SERVICE,
      currentAccount(),
      WALLET_KIND,
      new Set([CURRENT_TOKEN]),
    );

    expect(selection).toEqual({ status: "ambiguous" });
  });
});

describe("compatible secret reads", () => {
  it("honors an exact account created during compatibility recovery", async () => {
    const result = await preferCurrentSecretAfterRecovery({
      recovered: { ok: true, value: "recovered-predecessor" },
      readCurrent: async () => ({ ok: true, value: "concurrent-current" }),
    });

    expect(result).toEqual({ ok: true, value: "concurrent-current" });
  });

  it("uses a recovered value only while the exact account remains absent", async () => {
    const result = await preferCurrentSecretAfterRecovery({
      recovered: { ok: true, value: "recovered-predecessor" },
      readCurrent: async () => ({ ok: false, reason: "not_found" }),
    });

    expect(result).toEqual({ ok: true, value: "recovered-predecessor" });
  });

  it("does not mask an exact-account read failure after recovery", async () => {
    const result = await preferCurrentSecretAfterRecovery({
      recovered: { ok: true, value: "recovered-predecessor" },
      readCurrent: async () => ({ ok: false, reason: "denied" }),
    });

    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("accepts independently targeted duplicates only when values agree", async () => {
    const refs = [
      metadataRef({ sourceId: "item-a", service: "service.a" }),
      metadataRef({ sourceId: "item-b", service: "service.b" }),
    ];
    const result = await recoverCompatibleSecret({
      discover: async () => refs,
      read: async () => ({ ok: true, value: " shared-value\n" }),
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
      compatibleTokens: new Set([CURRENT_TOKEN]),
    });

    expect(result).toEqual({ ok: true, value: "shared-value" });
  });

  it("fails closed when compatible values diverge", async () => {
    const refs = [
      metadataRef({ sourceId: "item-a", service: "service.a" }),
      metadataRef({ sourceId: "item-b", service: "service.b" }),
    ];
    const result = await recoverCompatibleSecret({
      discover: async () => refs,
      read: async (candidate) => ({
        ok: true,
        value: candidate.service,
      }),
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
      compatibleTokens: new Set([CURRENT_TOKEN]),
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("fails closed when any selected candidate is unreadable", async () => {
    const refs = [
      metadataRef({ sourceId: "item-a", service: "service.a" }),
      metadataRef({ sourceId: "item-b", service: "service.b" }),
    ];
    const result = await recoverCompatibleSecret({
      discover: async () => refs,
      read: async (candidate) =>
        candidate.sourceId === "item-a"
          ? { ok: true, value: "value" }
          : { ok: false, reason: "denied" },
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
      compatibleTokens: new Set([CURRENT_TOKEN]),
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("rescans once when a candidate disappears", async () => {
    const itemA = metadataRef({ sourceId: "item-a", service: "service.a" });
    const itemB = metadataRef({ sourceId: "item-b", service: "service.b" });
    let discovery = 0;
    const result = await recoverCompatibleSecret({
      discover: async () => {
        discovery += 1;
        return discovery === 1 ? [itemA, itemB] : [itemA];
      },
      read: async (candidate) =>
        candidate.sourceId === "item-b"
          ? { ok: false, reason: "not_found" }
          : { ok: true, value: "value" },
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
      compatibleTokens: new Set([CURRENT_TOKEN]),
    });

    expect(discovery).toBe(2);
    expect(result).toEqual({ ok: true, value: "value" });
  });
});

describe("macOS metadata and add-only promotion", () => {
  it("parses generic-password metadata across arbitrary chunks", () => {
    const parser = new MacOSKeychainMetadataParser();
    const dump = [
      'keychain: "/tmp/login.keychain-db"\n',
      "version: 512\n",
      'class: "genp"\n',
      "attributes:\n",
      `    "acct"<blob>="previous-${CURRENT_TOKEN}:${WALLET_KIND}"\n`,
      '    "svce"<blob>="previous.service"\n',
      'keychain: "/tmp/login.keychain-db"\n',
      'class: "inet"\n',
      '    "acct"<blob>="ignored"\n',
      '    "svce"<blob>="ignored"\n',
    ].join("");
    for (let index = 0; index < dump.length; index += 7) {
      parser.push(dump.slice(index, index + 7));
    }

    expect(parser.finish()).toEqual([
      {
        sourceId: `/tmp/login.keychain-db\u0000previous.service\u0000previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        targetId: `/tmp/login.keychain-db\u0000previous.service\u0000previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        service: "previous.service",
        account: `previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        locator: "/tmp/login.keychain-db",
      },
    ]);
  });

  it("verifies a successful add-only promotion", async () => {
    const addOnly = vi.fn(async () => undefined);
    const result = await promoteRecoveredMacOSSecret({
      recoveredValue: "recovered",
      addOnly,
      readCurrent: async () => ({ ok: true, value: "recovered" }),
    });

    expect(addOnly).toHaveBeenCalledWith("recovered");
    expect(result).toEqual({ ok: true, value: "recovered" });
  });

  it("honors the exact winner after a concurrent add", async () => {
    const result = await promoteRecoveredMacOSSecret({
      recoveredValue: "recovered",
      addOnly: async () => {
        throw new Error("duplicate");
      },
      readCurrent: async () => ({ ok: true, value: "concurrent-winner" }),
    });

    expect(result).toEqual({ ok: true, value: "concurrent-winner" });
  });

  it("fails when a successful add does not read back identically", async () => {
    const result = await promoteRecoveredMacOSSecret({
      recoveredValue: "recovered",
      addOnly: async () => undefined,
      readCurrent: async () => ({ ok: true, value: "different" }),
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
  });
});

type DbusMessage = Parameters<SecretServiceMetadataBus["invoke"]>[0];

function aoVariant(paths: string[]): unknown {
  return [[{ type: "a", child: [{ type: "o", child: [] }] }], [paths]];
}

function attributesVariant(attributes: Record<string, string>): unknown {
  return [
    [
      {
        type: "a",
        child: [
          {
            type: "{",
            child: [
              { type: "s", child: [] },
              { type: "s", child: [] },
            ],
          },
        ],
      },
    ],
    [Object.entries(attributes)],
  ];
}

describe("Secret Service metadata enumeration", () => {
  it("reads Collections, Items, and Attributes without secret APIs", async () => {
    const messages: DbusMessage[] = [];
    const responses = new Map<string, unknown>([
      [
        "/org/freedesktop/secrets:Collections",
        aoVariant(["/collection/a", "/collection/b"]),
      ],
      [
        "/collection/a:Items",
        aoVariant(["/collection/a/item/1", "/collection/a/item/2"]),
      ],
      ["/collection/b:Items", aoVariant(["/collection/a/item/2"])],
      [
        "/collection/a/item/1:Attributes",
        attributesVariant({
          service: "service.a",
          account: `previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        }),
      ],
      [
        "/collection/a/item/2:Attributes",
        attributesVariant({
          service: "service.b",
          account: `previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        }),
      ],
    ]);
    const bus: SecretServiceMetadataBus = {
      invoke(message, callback) {
        messages.push(message);
        callback(
          undefined,
          responses.get(`${message.path}:${message.body[1]}`),
        );
      },
    };

    const refs = await enumerateSecretServiceMetadata(bus, 100);

    expect(refs).toHaveLength(2);
    expect(messages).toHaveLength(5);
    expect(messages.every((message) => message.member === "Get")).toBe(true);
    expect(
      messages.every((message) =>
        ["Collections", "Items", "Attributes"].includes(message.body[1]),
      ),
    ).toBe(true);
    expect(
      messages.some((message) =>
        ["GetSecret", "GetSecrets", "OpenSession", "Unlock"].includes(
          message.member,
        ),
      ),
    ).toBe(false);
  });

  it("times out instead of leaving a metadata request pending", async () => {
    const bus: SecretServiceMetadataBus = {
      invoke() {},
    };

    await expect(enumerateSecretServiceMetadata(bus, 5)).rejects.toThrow(
      "timed out",
    );
  });

  it("rejects an oversized collection list before traversing it", async () => {
    const messages: DbusMessage[] = [];
    const bus: SecretServiceMetadataBus = {
      invoke(message, callback) {
        messages.push(message);
        callback(
          undefined,
          aoVariant(
            Array.from({ length: 65 }, (_, index) => `/collection/${index}`),
          ),
        );
      },
    };

    await expect(enumerateSecretServiceMetadata(bus, 100)).rejects.toThrow(
      "too many collections",
    );
    expect(messages).toHaveLength(1);
  });

  it("rejects an oversized item list before reading attributes", async () => {
    const messages: DbusMessage[] = [];
    const bus: SecretServiceMetadataBus = {
      invoke(message, callback) {
        messages.push(message);
        if (message.body[1] === "Collections") {
          callback(undefined, aoVariant(["/collection/a"]));
          return;
        }
        callback(
          undefined,
          aoVariant(
            Array.from(
              { length: 4_097 },
              (_, index) => `/collection/a/item/${index}`,
            ),
          ),
        );
      },
    };

    await expect(enumerateSecretServiceMetadata(bus, 100)).rejects.toThrow(
      "too many items",
    );
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.body[1] === "Attributes")).toBe(
      false,
    );
  });

  it("translates a connection error instead of emitting it unhandled", async () => {
    const connection = new EventEmitter();
    const end = vi.fn();
    Object.assign(connection, { end });
    const bus: RuntimeSecretServiceBus = {
      connection,
      invoke() {
        connection.emit("error", new Error("unreachable session bus"));
      },
    };

    await expect(
      enumerateLinuxSecretServiceMetadataForBus(bus, 5),
    ).rejects.toThrow("Secret Service metadata connection failed");
    expect(end).toHaveBeenCalledOnce();
    expect(connection.listenerCount("error")).toBe(0);
  });
});

describe("reset cleanup", () => {
  it("is idempotent when metadata confirms the account is absent", () => {
    expect(
      collectSecureStoreCleanupTargets(
        [],
        CURRENT_SERVICE,
        currentAccount(),
        WALLET_KIND,
        new Set([CURRENT_TOKEN, PRIOR_TOKEN]),
      ),
    ).toEqual([]);
  });

  it("includes an exact current account when metadata contains it", () => {
    const exact: SecureStoreMetadataRef = {
      sourceId: "current-item",
      targetId: "current-target",
      service: CURRENT_SERVICE,
      account: currentAccount(),
    };

    expect(
      collectSecureStoreCleanupTargets(
        [exact],
        CURRENT_SERVICE,
        currentAccount(),
        WALLET_KIND,
        new Set([CURRENT_TOKEN, PRIOR_TOKEN]),
      ),
    ).toEqual([exact]);
  });

  it("removes every derived predecessor so restart cannot recover it", async () => {
    let refs = [
      metadataRef({ sourceId: "wallet", kind: WALLET_KIND }),
      metadataRef({ sourceId: "steward", kind: STEWARD_KIND }),
      metadataRef({
        sourceId: "other-install",
        token: UNKNOWN_TOKEN,
        kind: WALLET_KIND,
      }),
    ];
    const walletTargets = selectCompatibleCleanupTargets(
      refs,
      CURRENT_SERVICE,
      currentAccount(WALLET_KIND),
      WALLET_KIND,
      new Set([CURRENT_TOKEN, PRIOR_TOKEN]),
    );
    expect(walletTargets.status).toBe("selected");
    if (walletTargets.status !== "selected") return;
    const removed = new Set(
      walletTargets.candidates.map((ref) => ref.sourceId),
    );
    refs = refs.filter((ref) => !removed.has(ref.sourceId));

    const afterRestart = await recoverCompatibleSecret({
      discover: async () => refs,
      read: async () => ({ ok: true, value: "must-not-return" }),
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(WALLET_KIND),
      kind: WALLET_KIND,
      compatibleTokens: new Set([CURRENT_TOKEN, PRIOR_TOKEN]),
    });

    expect(afterRestart).toEqual({ ok: false, reason: "not_found" });
    expect(refs.map((ref) => ref.sourceId)).toContain("other-install");
    expect(refs.map((ref) => ref.sourceId)).toContain("steward");
  });
});
