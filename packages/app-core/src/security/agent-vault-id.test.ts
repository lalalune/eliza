/**
 * Tests the agent vault id: a deterministic sha256 over the canonical state dir
 * (base64url-truncated, stable `eliza1-` prefix) that namespaces an agent's
 * secrets in the OS keychain, plus the `<vaultId>:<kind>` keychain-account
 * derivation. The same install always resolves the same vault, and two
 * different state dirs never collide onto one keychain namespace.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAgentVaultId,
  deriveCompatibleVaultTokens,
  keychainAccountForSecretKind,
} from "./agent-vault-id.ts";

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

  it("derives current and home-scoped state-root compatibility tokens", () => {
    const current = deriveAgentVaultId("/Users/x/.local/state/eliza");
    const tokens = deriveCompatibleVaultTokens(current, {
      homeDir: "/Users/x",
      namespace: "eliza",
    });

    expect(tokens).toContain(current.slice("eliza1-".length));
    expect(tokens).toContain(
      deriveAgentVaultId("/Users/x/.eliza").slice("eliza1-".length),
    );
    expect(tokens).toHaveLength(2);
  });

  it("preserves hyphens inside the fixed-width state token", () => {
    const token = "AbCdEf0123_-wXyZ";

    expect(
      deriveCompatibleVaultTokens(`eliza1-${token}`, {
        homeDir: "/Users/x",
        namespace: "eliza",
      }),
    ).toContain(token);
  });
});

describe("keychainAccountForSecretKind", () => {
  it("namespaces the secret kind under the vault id", () => {
    expect(keychainAccountForSecretKind("eliza1-abc", "wallet" as never)).toBe(
      "eliza1-abc:wallet",
    );
  });
});
