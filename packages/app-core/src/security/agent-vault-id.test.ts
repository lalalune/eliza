/**
 * Tests the agent vault id: a deterministic sha256 over the canonical state dir
 * (base64url-truncated, stable `eliza1-` prefix) that namespaces an agent's
 * secrets in the OS keychain, plus the `<vaultId>:<kind>` keychain-account
 * derivation. The same install always resolves the same vault, and two
 * different state dirs never collide onto one keychain namespace.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveAgentVaultId,
  keychainAccountForSecretKind,
  resolveCanonicalStateDir,
} from "./agent-vault-id.ts";

const ORIGINAL_STATE_DIR = process.env.ELIZA_STATE_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_STATE_DIR === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = ORIGINAL_STATE_DIR;
});

describe("deriveAgentVaultId", () => {
  it("is deterministic for a given state dir and prefixed", () => {
    const a = deriveAgentVaultId("/Users/x/.eliza");
    const b = deriveAgentVaultId("/Users/x/.eliza");
    expect(a).toBe(b);
    expect(a).toMatch(/^eliza1-[A-Za-z0-9_-]{16}$/);
  });

  it("distinguishes different state dirs", () => {
    expect(deriveAgentVaultId("/Users/x/.eliza")).not.toBe(
      deriveAgentVaultId("/Users/y/.eliza"),
    );
  });

  it("uses the resolved path only when the state directory does not exist", () => {
    const stateDir = "/tmp/eliza-missing-state";
    process.env.ELIZA_STATE_DIR = stateDir;
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    expect(resolveCanonicalStateDir()).toBe(path.resolve(stateDir));
  });

  it("surfaces canonicalization failures other than a missing directory", () => {
    process.env.ELIZA_STATE_DIR = "/tmp/eliza-inaccessible-state";
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });

    expect(() => resolveCanonicalStateDir()).toThrowError(
      expect.objectContaining({
        code: "AGENT_STATE_DIR_CANONICALIZATION_FAILED",
      }),
    );
  });
});

describe("keychainAccountForSecretKind", () => {
  it("namespaces the secret kind under the vault id", () => {
    expect(keychainAccountForSecretKind("eliza1-abc", "wallet" as never)).toBe(
      "eliza1-abc:wallet",
    );
  });
});
