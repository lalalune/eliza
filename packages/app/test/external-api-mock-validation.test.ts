/**
 * Binds every explicitly tagged external-provider UI-smoke fixture to real
 * validation artifacts or a reasoned, current exemption.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const UI_SMOKE_DIR = path.join(HERE, "ui-smoke");

type ValidationArtifacts = {
  contract: string;
  real: string;
  fixtures: string;
};

type MockSource = {
  file: string;
  line: number;
};

const VALIDATED: Readonly<Record<string, ValidationArtifacts>> = {
  polymarket: {
    contract: "plugins/plugin-polymarket/src/routes.contract.test.ts",
    real: "plugins/plugin-polymarket/src/routes.real.test.ts",
    fixtures: "plugins/plugin-polymarket/src/__fixtures__",
  },
  hyperliquid: {
    contract: "plugins/plugin-hyperliquid/src/routes.contract.test.ts",
    real: "plugins/plugin-hyperliquid/src/routes.real.test.ts",
    fixtures: "plugins/plugin-hyperliquid/src/__fixtures__",
  },
  coingecko: {
    contract:
      "plugins/plugin-wallet/src/routes/wallet-market-overview.contract.test.ts",
    real: "plugins/plugin-wallet/src/routes/wallet-market-overview.real.test.ts",
    fixtures: "plugins/plugin-wallet/src/routes/__fixtures__",
  },
};

const CONTRACT_TESTED: Readonly<Record<string, string>> = {};

const EXEMPTIONS: Readonly<Record<string, string>> = {
  "location-weather":
    "The browser calls ipapi and Open-Meteo directly; their small public JSON " +
    "fixtures do not pass through a repository-owned provider parser.",
  shopify:
    "The retained provider-shaped smoke DTOs have no current recorded-response " +
    "replay and live-drift harness.",
  "wallet-rpc":
    "EVM, Solana, token-balance, and NFT providers are aggregated behind wallet " +
    "DTOs and still need recorded upstream fixtures.",
  elevenlabs:
    "The smoke fixture is binary TTS output; the provider's JSON voices contract " +
    "still needs recorded evidence.",
  google:
    "Calendar, Gmail, Drive, and YouTube validation requires OAuth-gated recorded " +
    "fixtures for each upstream surface.",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(absolutePath);
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolutePath] : [];
  });
}

function discoverExternalApiMocks(): Map<string, MockSource[]> {
  const discovered = new Map<string, MockSource[]>();
  const malformed: string[] = [];

  for (const absolutePath of sourceFiles(UI_SMOKE_DIR)) {
    const relativePath = path
      .relative(REPO_ROOT, absolutePath)
      .split(path.sep)
      .join("/");
    const source = readFileSync(absolutePath, "utf8");
    const lines = source.split("\n");

    for (const [index, line] of lines.entries()) {
      if (!line.includes("external-api-mock:")) {
        continue;
      }
      const match = line.match(
        /external-api-mock:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\b/,
      );
      if (!match?.[1]) {
        malformed.push(`${relativePath}:${index + 1}`);
        continue;
      }
      const api = match[1];
      const existing = discovered.get(api) ?? [];
      existing.push({ file: relativePath, line: index + 1 });
      discovered.set(api, existing);
    }
  }

  expect(
    malformed,
    "External API mock tags must use `external-api-mock: lowercase-kebab-id`.",
  ).toEqual([]);
  return discovered;
}

describe("external API mock validation authority", () => {
  it("classifies every source-tagged mock exactly once", () => {
    const discovered = discoverExternalApiMocks();
    const classifications = [
      ...Object.keys(VALIDATED),
      ...Object.keys(CONTRACT_TESTED),
      ...Object.keys(EXEMPTIONS),
    ];
    const duplicates = classifications.filter(
      (api, index) => classifications.indexOf(api) !== index,
    );
    const stale = classifications.filter((api) => !discovered.has(api));
    const unclassified = [...discovered.keys()].filter(
      (api) => !classifications.includes(api),
    );
    const blankExemptions = Object.entries(EXEMPTIONS)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([api]) => api);

    expect(
      duplicates,
      "An external API mock cannot occupy more than one validation tier.",
    ).toEqual([]);
    expect(
      stale,
      "Remove classifications whose source-tagged mock no longer exists.",
    ).toEqual([]);
    expect(
      unclassified,
      "Every source-tagged external API mock needs validation artifacts or an exemption.",
    ).toEqual([]);
    expect(
      blankExemptions,
      "Every external API mock exemption must explain the current boundary.",
    ).toEqual([]);
    expect(
      [...new Set(classifications)].sort(),
      "The validation authority must exactly partition the live mock sources.",
    ).toEqual([...discovered.keys()].sort());
  });

  it("keeps every validated mock tied to its recorded and live artifacts", () => {
    const missing: string[] = [];
    for (const [api, files] of Object.entries(VALIDATED)) {
      for (const file of [files.contract, files.real, files.fixtures]) {
        if (!existsSync(path.join(REPO_ROOT, file))) {
          missing.push(`${api}: ${file}`);
        }
      }
    }
    expect(
      missing,
      "A validated external API mock lost its real-validation harness.",
    ).toEqual([]);
  });

  it("keeps every contract-tested mock tied to its recorded artifact", () => {
    const missing = Object.entries(CONTRACT_TESTED)
      .filter(([, file]) => !existsSync(path.join(REPO_ROOT, file)))
      .map(([api, file]) => `${api}: ${file}`);
    expect(
      missing,
      "A contract-tested external API mock lost its recorded contract test.",
    ).toEqual([]);
  });

  it("reports the source artifact for every classified mock", () => {
    const discovered = discoverExternalApiMocks();
    const missingSources = [
      ...Object.keys(VALIDATED),
      ...Object.keys(CONTRACT_TESTED),
      ...Object.keys(EXEMPTIONS),
    ].filter((api) => (discovered.get(api)?.length ?? 0) === 0);

    expect(
      missingSources,
      "Every classification must point back to at least one live UI-smoke fixture.",
    ).toEqual([]);
  });
});
