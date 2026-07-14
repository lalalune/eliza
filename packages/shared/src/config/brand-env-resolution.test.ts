/**
 * Consolidated regression test that the whole brand-env surface resolves for a
 * non-ELIZA prefix through the alias-aware reader WITHOUT materializing the
 * `ELIZA_*` mirror (#13422). Unlike the per-slice tests that hand-author alias
 * pairs, this drives the REAL table from `buildBrandEnvAliases("ACME")` (the
 * single source of truth) end to end — state dir, API token, ports, CORS/host
 * allow-lists, bind host, expose-port flag, and the mobile-platform flag — so a
 * suffix renamed in `brand-env-aliases.ts` that broke any consumer is caught
 * here. Deterministic; sets an ACME_* env record and asserts no ELIZA_* key is
 * ever written. Pairs with the static `alias-read-guard.mjs` that forbids new
 * raw reads bypassing this reader.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAndroidMobile,
  isMobilePlatform,
  resolveApiExposePort,
  resolveApiSecurityConfig,
  resolveDesktopApiPortPreference,
  resolvePlatform,
  resolveRuntimePorts,
} from "../runtime-env";
import {
  getBootConfig,
  resolveAliasedEnvValue,
  setBootConfig,
} from "./boot-config";
import { buildBrandEnvAliases } from "./brand-env-aliases";

const ALIASES = buildBrandEnvAliases("ACME");

/** A full ACME_* deployment env — the canonical ELIZA_* keys are all absent. */
function acmeEnv(): Record<string, string | undefined> {
  return {
    ACME_STATE_DIR: "/home/acme/.local/state/acme",
    ACME_API_TOKEN: "acme-secret-token",
    ACME_API_BIND: "0.0.0.0",
    ACME_API_EXPOSE_PORT: "true",
    ACME_PORT: "4666",
    ACME_API_PORT: "4555",
    ACME_UI_PORT: "4777",
    ACME_ALLOWED_ORIGINS: " https://acme.example, http://localhost:2138 ",
    ACME_ALLOWED_HOSTS: " acme.example,localhost ",
    ACME_ALLOW_NULL_ORIGIN: "true",
    ACME_DISABLE_AUTO_API_TOKEN: "1",
    ACME_PLATFORM: "android",
  };
}

function elizaMirrorKeys(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((key) => key.startsWith("ELIZA_"));
}

describe("brand-env resolution for an ACME_* prefix (no ELIZA_* mirror)", () => {
  const savedConfig = getBootConfig();

  beforeEach(() => {
    // runtime-env resolvers read the alias table from the boot config; pin it to
    // the real ACME table so they resolve the branded keys.
    setBootConfig({ ...savedConfig, envAliases: ALIASES });
  });

  afterEach(() => {
    setBootConfig(savedConfig);
  });

  it("resolves the state dir via the reader from the branded key", () => {
    const env = acmeEnv();
    expect(resolveAliasedEnvValue("ELIZA_STATE_DIR", ALIASES, env)).toBe(
      "/home/acme/.local/state/acme",
    );
    expect(env).not.toHaveProperty("ELIZA_STATE_DIR");
  });

  it("resolves the API token via the reader and the security config", () => {
    const env = acmeEnv();
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env)).toBe(
      "acme-secret-token",
    );
    expect(resolveApiSecurityConfig(env).token).toBe("acme-secret-token");
    expect(env).not.toHaveProperty("ELIZA_API_TOKEN");
  });

  it("resolves the ports from the branded keys", () => {
    const env = acmeEnv();
    expect(resolveRuntimePorts(env)).toEqual({
      serverOnlyPort: 4666,
      desktopApiPort: 4555,
      desktopUiPort: 4777,
    });
    expect(resolveDesktopApiPortPreference(env)).toMatchObject({
      port: 4555,
      winningKey: "ACME_API_PORT",
    });
  });

  it("resolves CORS/allowed origins, hosts, and bind host from the branded keys", () => {
    const config = resolveApiSecurityConfig(acmeEnv());
    expect(config.bindHost).toBe("0.0.0.0");
    expect(config.allowedOrigins).toEqual([
      "https://acme.example",
      "http://localhost:2138",
    ]);
    expect(config.allowedHosts).toEqual(["acme.example", "localhost"]);
    expect(config.allowNullOrigin).toBe(true);
    expect(config.disableAutoApiToken).toBe(true);
    expect(config.isWildcardBind).toBe(true);
    expect(config.isLoopbackBind).toBe(false);
  });

  it("resolves the expose-port flag from the branded key", () => {
    expect(resolveApiExposePort(acmeEnv())).toBe(true);
  });

  it("resolves the mobile-platform flag from the branded key", () => {
    const env = acmeEnv();
    expect(isMobilePlatform(env)).toBe(true);
    expect(isAndroidMobile(env)).toBe(true);
    expect(resolvePlatform(env)).toBe("android");
  });

  it("never materializes any ELIZA_* mirror while resolving the whole surface", () => {
    const env = acmeEnv();
    const before = { ...env };

    resolveAliasedEnvValue("ELIZA_STATE_DIR", ALIASES, env);
    resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env);
    resolveRuntimePorts(env);
    resolveApiSecurityConfig(env);
    resolveApiExposePort(env);
    isMobilePlatform(env);
    resolvePlatform(env);

    // The reader is additive: it must not write the canonical mirror, and it
    // must not mutate the branded env record at all.
    expect(elizaMirrorKeys(env)).toEqual([]);
    expect(env).toEqual(before);
  });

  it("prefers an explicit canonical ELIZA_* value over the branded alias", () => {
    const env = acmeEnv();
    env.ELIZA_API_TOKEN = "canonical-wins";
    // A deployment that sets BOTH still gets the canonical value — the branded
    // alias never suppresses a present ELIZA_* value.
    expect(resolveApiSecurityConfig(env).token).toBe("canonical-wins");
    expect(resolveAliasedEnvValue("ELIZA_API_TOKEN", ALIASES, env)).toBe(
      "canonical-wins",
    );
  });
});
