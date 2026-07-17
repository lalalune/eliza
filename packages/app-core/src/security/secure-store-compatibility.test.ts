/**
 * Exercises metadata-only secure-store recovery with deterministic command and
 * D-Bus boundaries. The suite covers selection, concurrent promotion, bounded
 * disappearance handling, and reset behavior without reading a host keychain.
 */
import { EventEmitter } from "node:events";

import { logger } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import type {
  SecureStoreGetResult,
  SecureStoreSecretKind,
} from "./platform-secure-store";
import {
  createNodePlatformSecureStore,
  enumerateLinuxSecretServiceMetadataForBus,
  isLinuxSecretToolNotFoundError,
  isNodePlatformSecureStoreSupported,
  isWalletOsStoreReadEnabled,
  type RuntimeSecretServiceBus,
} from "./platform-secure-store-node";
import {
  cleanupCurrentAndCompatibleSecret,
  collectSecureStoreCleanupTargets,
  enumerateSecretServiceMetadata,
  MacOSKeychainMetadataParser,
  preferCurrentSecretAfterRecovery,
  promoteRecoveredMacOSSecret,
  readCurrentOrRecover,
  recoverCompatibleSecret,
  type SecretServiceMetadataBus,
  type SecureStoreMetadataRef,
  SecureStoreMetadataSnapshotCache,
  selectCompatibleCandidates,
  selectCompatibleCleanupTargets,
} from "./secure-store-compatibility";

const CURRENT_SERVICE = "ai.elizaos.agent.vault";
const CURRENT_TOKEN = "AbCdEf0123_-wXyZ";
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
  const service = options.service ?? CURRENT_SERVICE;
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
  ])("selects a same-service predecessor prefix for %s", (kind) => {
    const candidate = metadataRef({
      sourceId: "candidate",
      kind,
    });
    const selection = selectCompatibleCandidates(
      [candidate],
      CURRENT_SERVICE,
      currentAccount(kind),
      kind,
    );

    expect(selection).toEqual({
      status: "selected",
      candidates: [candidate],
    });
  });

  it("rejects other services, malformed accounts, kinds, and state tokens", () => {
    const refs: SecureStoreMetadataRef[] = [
      metadataRef({ sourceId: "unknown", token: UNKNOWN_TOKEN }),
      metadataRef({ sourceId: "other-kind", kind: STEWARD_KIND }),
      metadataRef({ sourceId: "other-service", service: "other.service" }),
      {
        sourceId: "malformed",
        targetId: "malformed",
        service: CURRENT_SERVICE,
        account: `missing-token:${WALLET_KIND}`,
      },
    ];

    expect(
      selectCompatibleCandidates(
        refs,
        CURRENT_SERVICE,
        currentAccount(),
        WALLET_KIND,
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
    );

    expect(selection).toEqual({ status: "ambiguous" });
  });

  it("bounds the number of targeted predecessor operations", () => {
    const selection = selectCompatibleCandidates(
      Array.from({ length: 9 }, (_, index) =>
        metadataRef({ sourceId: `item-${index}`, prefix: `previous${index}` }),
      ),
      CURRENT_SERVICE,
      currentAccount(),
      WALLET_KIND,
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

  it("honors an exact account created while recovery itself fails", async () => {
    const result = await preferCurrentSecretAfterRecovery({
      recovered: { ok: false, reason: "error", message: "metadata changed" },
      readCurrent: async () => ({ ok: true, value: "concurrent-current" }),
    });

    expect(result).toEqual({ ok: true, value: "concurrent-current" });
  });

  it("accepts independently targeted duplicates only when values agree", async () => {
    const refs = [
      metadataRef({ sourceId: "item-a", prefix: "previousA" }),
      metadataRef({ sourceId: "item-b", prefix: "previousB" }),
    ];
    const result = await recoverCompatibleSecret({
      discover: async () => refs,
      read: async () => ({ ok: true, value: " shared-value\n" }),
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
    });

    expect(result).toEqual({ ok: true, value: "shared-value" });
  });

  it("fails closed when compatible values diverge", async () => {
    const refs = [
      metadataRef({ sourceId: "item-a", prefix: "previousA" }),
      metadataRef({ sourceId: "item-b", prefix: "previousB" }),
    ];
    const result = await recoverCompatibleSecret({
      discover: async () => refs,
      read: async (candidate) => ({
        ok: true,
        value: candidate.account,
      }),
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("fails closed when any selected candidate is unreadable", async () => {
    const refs = [
      metadataRef({ sourceId: "item-a", prefix: "previousA" }),
      metadataRef({ sourceId: "item-b", prefix: "previousB" }),
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
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
  });

  it("rescans once when a candidate disappears", async () => {
    const itemA = metadataRef({ sourceId: "item-a", prefix: "previousA" });
    const itemB = metadataRef({ sourceId: "item-b", prefix: "previousB" });
    const refreshes: boolean[] = [];
    const result = await recoverCompatibleSecret({
      discover: async (forceRefresh) => {
        refreshes.push(forceRefresh);
        return forceRefresh ? [itemA] : [itemA, itemB];
      },
      read: async (candidate) =>
        candidate.sourceId === "item-b"
          ? { ok: false, reason: "not_found" }
          : { ok: true, value: "value" },
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
    });

    expect(refreshes).toEqual([false, true]);
    expect(result).toEqual({ ok: true, value: "value" });
  });

  it("caches metadata until a forced refresh is requested", async () => {
    let loads = 0;
    const cache = new SecureStoreMetadataSnapshotCache(async () => {
      loads += 1;
      return [metadataRef({ sourceId: `item-${loads}` })];
    });

    expect((await cache.get())[0]?.sourceId).toBe("item-1");
    expect((await cache.get())[0]?.sourceId).toBe("item-1");
    expect((await cache.get(true))[0]?.sourceId).toBe("item-2");
    expect(loads).toBe(2);
  });

  it("never lets an older in-flight load overwrite a forced refresh", async () => {
    let resolveFirst:
      | ((refs: readonly SecureStoreMetadataRef[]) => void)
      | undefined;
    let resolveSecond:
      | ((refs: readonly SecureStoreMetadataRef[]) => void)
      | undefined;
    let loads = 0;
    const cache = new SecureStoreMetadataSnapshotCache(() => {
      loads += 1;
      return new Promise<readonly SecureStoreMetadataRef[]>((resolve) => {
        if (loads === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    const first = cache.get();
    const second = cache.get(true);
    resolveSecond?.([metadataRef({ sourceId: "fresh" })]);
    await second;
    resolveFirst?.([metadataRef({ sourceId: "stale" })]);
    await first;

    expect((await cache.get())[0]?.sourceId).toBe("fresh");
  });

  it("does not reuse an in-flight snapshot after invalidation", async () => {
    const resolvers: Array<(refs: readonly SecureStoreMetadataRef[]) => void> =
      [];
    const cache = new SecureStoreMetadataSnapshotCache(
      () =>
        new Promise<readonly SecureStoreMetadataRef[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const stale = cache.get();
    cache.invalidate();
    const fresh = cache.get();
    expect(resolvers).toHaveLength(2);
    resolvers[1]([metadataRef({ sourceId: "fresh" })]);
    expect((await fresh)[0]?.sourceId).toBe("fresh");
    resolvers[0]([metadataRef({ sourceId: "stale" })]);
    await stale;
    expect((await cache.get())[0]?.sourceId).toBe("fresh");
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
      `    "svce"<blob>="${CURRENT_SERVICE}"\n`,
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
        sourceId: `/tmp/login.keychain-db\u0000${CURRENT_SERVICE}\u0000previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        targetId: `/tmp/login.keychain-db\u0000${CURRENT_SERVICE}\u0000previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
        service: CURRENT_SERVICE,
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

  it("preserves an exact-account read denial after an add race", async () => {
    const result = await promoteRecoveredMacOSSecret({
      recoveredValue: "recovered",
      addOnly: async () => {
        throw new Error("concurrent add");
      },
      readCurrent: async () => ({ ok: false, reason: "denied" }),
    });

    expect(result).toEqual({ ok: false, reason: "denied" });
  });

  it("bounds the keychain dump and individual metadata fields", () => {
    const oversizedDump = new MacOSKeychainMetadataParser();
    expect(() => oversizedDump.push("x".repeat(4 * 1_024 * 1_024 + 1))).toThrow(
      "size limit",
    );

    const oversizedLine = new MacOSKeychainMetadataParser();
    expect(() => oversizedLine.push("x".repeat(16_385))).toThrow("line");

    const oversizedField = new MacOSKeychainMetadataParser();
    oversizedField.push(
      [
        'keychain: "/tmp/login.keychain-db"',
        'class: "genp"',
        `    "acct"<blob>="previous-${CURRENT_TOKEN}:${WALLET_KIND}"`,
        `    "svce"<blob>="${"s".repeat(513)}"`,
      ].join("\n"),
    );
    expect(oversizedField.finish()).toEqual([]);

    const oversizedRecords = new MacOSKeychainMetadataParser();
    expect(() =>
      oversizedRecords.push(
        `${'keychain: "/tmp/login.keychain-db"\n'.repeat(4_098)}`,
      ),
    ).toThrow("too many records");
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

  it("applies one deadline across sequential metadata reads", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const bus: SecretServiceMetadataBus = {
        invoke(message, callback) {
          calls += 1;
          setTimeout(() => {
            callback(
              undefined,
              message.body[1] === "Collections"
                ? aoVariant(["/collection/a"])
                : aoVariant([]),
            );
          }, 6);
        },
      };

      const discovery = enumerateSecretServiceMetadata(bus, 10);
      const rejection = expect(discovery).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(6);
      await vi.advanceTimersByTimeAsync(4);
      await rejection;
      expect(calls).toBe(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

  it("caps raw item entries before deduplication across collections", async () => {
    const messages: DbusMessage[] = [];
    const repeated = Array.from(
      { length: 2_049 },
      () => "/collection/a/item/repeated",
    );
    const bus: SecretServiceMetadataBus = {
      invoke(message, callback) {
        messages.push(message);
        if (message.body[1] === "Collections") {
          callback(undefined, aoVariant(["/collection/a", "/collection/b"]));
          return;
        }
        callback(undefined, aoVariant(repeated));
      },
    };

    await expect(enumerateSecretServiceMetadata(bus, 100)).rejects.toThrow(
      "too many items",
    );
    expect(messages).toHaveLength(3);
  });

  it("bounds object paths, attributes, fields, and signature depth", async () => {
    const oversizedPathBus: SecretServiceMetadataBus = {
      invoke(_message, callback) {
        callback(undefined, aoVariant([`/${"a".repeat(1_024)}`]));
      },
    };
    await expect(
      enumerateSecretServiceMetadata(oversizedPathBus, 100),
    ).rejects.toMatchObject({ code: "SECURE_STORE_DBUS_PATH_INVALID" });

    const oversizedAttributesBus: SecretServiceMetadataBus = {
      invoke(message, callback) {
        if (message.body[1] === "Collections") {
          callback(undefined, aoVariant(["/collection/a"]));
          return;
        }
        if (message.body[1] === "Items") {
          callback(undefined, aoVariant(["/collection/a/item/1"]));
          return;
        }
        callback(
          undefined,
          attributesVariant(
            Object.fromEntries(
              Array.from({ length: 65 }, (_, index) => [`key${index}`, "v"]),
            ),
          ),
        );
      },
    };
    await expect(
      enumerateSecretServiceMetadata(oversizedAttributesBus, 100),
    ).rejects.toMatchObject({
      code: "SECURE_STORE_DBUS_ATTRIBUTE_LIMIT_EXCEEDED",
    });

    const deepTree = {
      type: "a",
      child: [
        {
          type: "a",
          child: [
            {
              type: "a",
              child: [
                {
                  type: "a",
                  child: [{ type: "a", child: [{ type: "o", child: [] }] }],
                },
              ],
            },
          ],
        },
      ],
    };
    const deepSignatureBus: SecretServiceMetadataBus = {
      invoke(_message, callback) {
        callback(undefined, [[deepTree], [[]]]);
      },
    };
    await expect(
      enumerateSecretServiceMetadata(deepSignatureBus, 100),
    ).rejects.toMatchObject({
      code: "SECURE_STORE_DBUS_SIGNATURE_DEPTH_EXCEEDED",
    });
  });

  it.each<{ attributes: Record<string, string>; code: string }>([
    {
      attributes: { ["k".repeat(129)]: "v" },
      code: "SECURE_STORE_DBUS_ATTRIBUTES_INVALID",
    },
    {
      attributes: { service: "v".repeat(1_025) },
      code: "SECURE_STORE_DBUS_ATTRIBUTES_INVALID",
    },
    {
      attributes: {
        service: "v".repeat(513),
        account: `previous-${CURRENT_TOKEN}:${WALLET_KIND}`,
      },
      code: "SECURE_STORE_METADATA_FIELD_INVALID",
    },
  ])("rejects bounded attribute payloads with $code", async ({
    attributes,
    code,
  }) => {
    const bus: SecretServiceMetadataBus = {
      invoke(message, callback) {
        if (message.body[1] === "Collections") {
          callback(undefined, aoVariant(["/collection/a"]));
          return;
        }
        if (message.body[1] === "Items") {
          callback(undefined, aoVariant(["/collection/a/item/1"]));
          return;
        }
        callback(undefined, attributesVariant(attributes));
      },
    };

    await expect(
      enumerateSecretServiceMetadata(bus, 100),
    ).rejects.toMatchObject({ code });
  });

  it("translates a connection error instead of emitting it unhandled", async () => {
    const connection = new EventEmitter();
    const stream = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      destroyed: boolean;
    };
    stream.end = vi.fn();
    stream.destroyed = false;
    Object.assign(connection, { stream });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const bus: RuntimeSecretServiceBus = {
      connection,
      invoke() {
        connection.emit("error", new Error("unreachable session bus"));
      },
    };

    await expect(
      enumerateLinuxSecretServiceMetadataForBus(bus, 5),
    ).rejects.toThrow("Secret Service metadata connection failed");
    expect(stream.end).toHaveBeenCalledOnce();
    expect(connection.listenerCount("error")).toBe(1);
    connection.emit("error", new Error("late teardown failure"));
    expect(warn).toHaveBeenCalled();
    stream.emit("close");
    expect(connection.listenerCount("error")).toBe(0);
  });
});

describe("reset cleanup", () => {
  it("deletes exact storage first and verifies a forced-fresh final snapshot", async () => {
    const predecessor = metadataRef({ sourceId: "predecessor" });
    const calls: string[] = [];
    let discovery = 0;

    await cleanupCurrentAndCompatibleSecret({
      deleteCurrent: async () => {
        calls.push("delete-current");
      },
      discover: async (forceRefresh) => {
        calls.push(`discover-${String(forceRefresh)}`);
        discovery += 1;
        return discovery === 1 ? [predecessor] : [];
      },
      deleteTarget: async (target) => {
        calls.push(`delete-${target.sourceId}`);
      },
      readCurrent: async () => {
        calls.push("read-current");
        return { ok: false, reason: "not_found" };
      },
      currentService: CURRENT_SERVICE,
      currentAccount: currentAccount(),
      kind: WALLET_KIND,
    });

    expect(calls).toEqual([
      "delete-current",
      "discover-true",
      "delete-predecessor",
      "read-current",
      "discover-true",
    ]);
  });

  it("is idempotent when metadata confirms the account is absent", () => {
    expect(
      collectSecureStoreCleanupTargets(
        [],
        CURRENT_SERVICE,
        currentAccount(),
        WALLET_KIND,
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
    });

    expect(afterRestart).toEqual({ ok: false, reason: "not_found" });
    expect(refs.map((ref) => ref.sourceId)).toContain("other-install");
    expect(refs.map((ref) => ref.sourceId)).toContain("steward");
  });
});

describe("platform gating and native status classification", () => {
  it("never exposes desktop subprocess stores to a mobile runtime", async () => {
    const mobileEnv = {
      ELIZA_PLATFORM: "ios",
      ELIZA_WALLET_OS_STORE: "1",
    };

    expect(isNodePlatformSecureStoreSupported("darwin", mobileEnv)).toBe(false);
    expect(isWalletOsStoreReadEnabled(mobileEnv, "darwin")).toBe(false);
    const store = createNodePlatformSecureStore("darwin", mobileEnv);
    expect(store.backend).toBe("none");
    await expect(store.get("vault", WALLET_KIND)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("treats only code 1 with empty stderr as a missing libsecret item", () => {
    expect(isLinuxSecretToolNotFoundError({ code: 1, stderr: "" })).toBe(true);
    expect(isLinuxSecretToolNotFoundError({ code: 1, stderr: "locked" })).toBe(
      false,
    );
    expect(isLinuxSecretToolNotFoundError({ code: 2, stderr: "" })).toBe(false);
  });
});
