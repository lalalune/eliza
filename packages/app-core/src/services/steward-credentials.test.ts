/**
 * Unit tests for `saveStewardCredentials` / `loadStewardCredentials`: verifies
 * steward secrets (apiKey, agentToken) land in the PlatformSecureStore rather
 * than the plaintext metadata file, that legacy plaintext secrets are migrated
 * and scrubbed on load, while unavailable or unreadable secure stores fail
 * without destroying the only credential copy. Uses an in-memory secure store
 * and a temp `ELIZA_STATE_DIR`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "../security/platform-secure-store";
import {
  loadStewardCredentials,
  resolveEffectiveStewardConfig,
  saveStewardCredentials,
} from "./steward-credentials";

class MemorySecureStore implements PlatformSecureStore {
  readonly backend = "none";
  readonly values = new Map<string, string>();

  constructor(private readonly available = true) {}

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const value = this.values.get(`${vaultId}:${kind}`);
    return value ? { ok: true, value } : { ok: false, reason: "not_found" };
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.values.set(`${vaultId}:${kind}`, value);
    return { ok: true };
  }

  async delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void> {
    this.values.delete(`${vaultId}:${kind}`);
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }
}

class ReadFailureSecureStore extends MemorySecureStore {
  constructor(private readonly reason: "denied" | "unavailable" | "error") {
    super(true);
  }

  override async get(): Promise<SecureStoreGetResult> {
    return { ok: false, reason: this.reason };
  }
}

class DivergentReadSecureStore extends MemorySecureStore {
  override async get(): Promise<SecureStoreGetResult> {
    return { ok: true, value: "different-value" };
  }
}

function credentialsPath(stateDir: string): string {
  return path.join(stateDir, "steward-credentials.json");
}

describe("steward credentials", () => {
  let previousStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    previousStateDir = process.env.ELIZA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-creds-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("stores steward secrets in the secure store, not the metadata file", async () => {
    const secureStore = new MemorySecureStore();

    await saveStewardCredentials(
      {
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
        apiKey: "tenant-api-key",
        agentToken: "agent-token",
        walletAddresses: { evm: "0xabc" },
        agentName: "Agent",
      },
      { secureStore },
    );

    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).toContain("0xabc");
    expect(raw).not.toContain("tenant-api-key");
    expect(raw).not.toContain("agent-token");

    const loaded = await loadStewardCredentials({ secureStore });
    expect(loaded).toMatchObject({
      apiUrl: "https://steward.local",
      tenantId: "tenant-1",
      agentId: "agent-1",
      apiKey: "tenant-api-key",
      agentToken: "agent-token",
    });
  });

  it("migrates legacy plaintext secrets and scrubs the file", async () => {
    const secureStore = new MemorySecureStore();
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify(
        {
          apiUrl: "https://legacy.local",
          tenantId: "tenant-legacy",
          agentId: "agent-legacy",
          apiKey: "legacy-api-key",
          agentToken: "legacy-agent-token",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const loaded = await loadStewardCredentials({ secureStore });

    expect(loaded).toMatchObject({
      apiUrl: "https://legacy.local",
      tenantId: "tenant-legacy",
      agentId: "agent-legacy",
      apiKey: "legacy-api-key",
      agentToken: "legacy-agent-token",
    });
    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).not.toContain("legacy-api-key");
    expect(raw).not.toContain("legacy-agent-token");
  });

  it("preserves legacy plaintext when secure-store migration is unavailable", async () => {
    const secureStore = new MemorySecureStore(false);
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify(
        {
          apiUrl: "https://legacy.local",
          tenantId: "tenant-legacy",
          agentId: "agent-legacy",
          apiKey: "legacy-api-key",
          agentToken: "legacy-agent-token",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    await expect(loadStewardCredentials({ secureStore })).rejects.toThrowError(
      expect.objectContaining({ code: "SECURE_STORE_READ_UNAVAILABLE" }),
    );
    const raw = fs.readFileSync(credentialsPath(stateDir), "utf8");
    expect(raw).toContain("legacy-api-key");
    expect(raw).toContain("legacy-agent-token");
  });

  it("preserves plaintext until migrated values round-trip exactly", async () => {
    const raw = JSON.stringify({
      apiUrl: "https://legacy.local",
      tenantId: "tenant-legacy",
      agentId: "agent-legacy",
      apiKey: "legacy-api-key",
      agentToken: "legacy-agent-token",
    });
    fs.writeFileSync(credentialsPath(stateDir), raw, { mode: 0o600 });

    await expect(
      loadStewardCredentials({
        secureStore: new DivergentReadSecureStore(),
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "SECURE_STORE_MIGRATION_VERIFICATION_FAILED",
      }),
    );
    expect(fs.readFileSync(credentialsPath(stateDir), "utf8")).toBe(raw);
  });

  it("does not write metadata when the secure store is unavailable", async () => {
    await expect(
      saveStewardCredentials(
        {
          apiUrl: "https://steward.local",
          tenantId: "tenant-1",
          agentId: "agent-1",
          apiKey: "tenant-api-key",
          agentToken: "agent-token",
        },
        { secureStore: new MemorySecureStore(false) },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "SECURE_STORE_WRITE_UNAVAILABLE" }),
    );
    expect(fs.existsSync(credentialsPath(stateDir))).toBe(false);
  });

  it.each([
    ["denied", "SECURE_STORE_READ_DENIED"],
    ["unavailable", "SECURE_STORE_READ_UNAVAILABLE"],
    ["error", "SECURE_STORE_READ_FAILED"],
  ] as const)("surfaces %s secure-store reads", async (reason, code) => {
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify({
        apiUrl: "https://steward.local",
        tenantId: "tenant-1",
        agentId: "agent-1",
      }),
      { mode: 0o600 },
    );

    await expect(
      loadStewardCredentials({
        secureStore: new ReadFailureSecureStore(reason),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code }));
  });

  it("uses a complete environment without reading stale persisted secrets", async () => {
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify({
        apiUrl: "https://stale.local",
        tenantId: "stale-tenant",
        agentId: "stale-agent",
        apiKey: "stale-api-key",
        agentToken: "stale-agent-token",
        agentName: "Persisted name",
      }),
      { mode: 0o600 },
    );
    const secureStore = new MemorySecureStore(false);

    const resolved = await resolveEffectiveStewardConfig(
      {
        STEWARD_API_URL: "https://env.local",
        STEWARD_AGENT_TOKEN: "env-agent-token",
      },
      { secureStore },
    );

    expect(resolved).toMatchObject({
      apiUrl: "https://env.local",
      tenantId: "",
      agentId: "",
      apiKey: "",
      agentToken: "env-agent-token",
    });
  });

  it("surfaces corrupt credential metadata", async () => {
    fs.writeFileSync(credentialsPath(stateDir), "{not-json", { mode: 0o600 });

    await expect(
      loadStewardCredentials({ secureStore: new MemorySecureStore() }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "STEWARD_CREDENTIALS_INVALID" }),
    );
  });

  it("rejects syntactically valid metadata with invalid field types", async () => {
    fs.writeFileSync(
      credentialsPath(stateDir),
      JSON.stringify({
        apiUrl: 42,
        tenantId: {},
        agentId: true,
        walletAddresses: { evm: 7 },
      }),
      { mode: 0o600 },
    );

    await expect(
      loadStewardCredentials({ secureStore: new MemorySecureStore() }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "STEWARD_CREDENTIALS_INVALID" }),
    );
  });

  it("surfaces credential-file I/O errors", async () => {
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    try {
      await expect(
        loadStewardCredentials({ secureStore: new MemorySecureStore() }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "STEWARD_CREDENTIALS_READ_FAILED" }),
      );
    } finally {
      spy.mockRestore();
      expect(fs.readFileSync).toBe(read);
    }
  });

  it("preserves prior metadata when the atomic rename fails", async () => {
    const prior = JSON.stringify({
      apiUrl: "https://prior.local",
      tenantId: "prior-tenant",
      agentId: "prior-agent",
    });
    fs.writeFileSync(credentialsPath(stateDir), prior, { mode: 0o600 });
    const spy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    try {
      await expect(
        saveStewardCredentials(
          {
            apiUrl: "https://new.local",
            tenantId: "new-tenant",
            agentId: "new-agent",
            apiKey: "new-key",
            agentToken: "new-token",
          },
          { secureStore: new MemorySecureStore() },
        ),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "STEWARD_CREDENTIALS_WRITE_FAILED" }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(credentialsPath(stateDir), "utf8")).toBe(prior);
  });
});
