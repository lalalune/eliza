/**
 * Binds every external-provider UI-smoke route fixture to real validation
 * artifacts or a reasoned, current exemption. Discovery walks page.route calls
 * directly, so comments and classification records cannot hide a new fixture.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
  pattern: string;
};

type ProviderRouteRule = {
  api: string;
  matches: (routePattern: string) => boolean;
};

const PROVIDER_ROUTE_RULES: readonly ProviderRouteRule[] = [
  {
    api: "location-weather",
    matches: (pattern) =>
      pattern.includes("ipapi") || pattern.includes("open-meteo"),
  },
  {
    api: "hyperliquid",
    matches: (pattern) => pattern.includes("/api/hyperliquid/"),
  },
  {
    api: "polymarket",
    matches: (pattern) => pattern.includes("/api/polymarket/"),
  },
  {
    api: "shopify",
    matches: (pattern) => pattern.includes("/api/shopify/"),
  },
  {
    api: "coingecko",
    matches: (pattern) => pattern.includes("/api/wallet/market-overview"),
  },
  {
    api: "wallet-rpc",
    matches: (pattern) =>
      /\/api\/wallet\/(?:config|addresses|balances|nfts)(?:\W|$)/.test(pattern),
  },
  {
    api: "google",
    matches: (pattern) =>
      pattern.includes("/api/connectors/google/") ||
      pattern.includes("/api/lifeops/connectors/google/"),
  },
  {
    api: "elevenlabs",
    matches: (pattern) =>
      pattern.includes("/api/tts/elevenlabs") ||
      pattern.includes("/api/tts/{cloud,elevenlabs}"),
  },
];

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

function discoverExternalApiMocksFromSources(
  files: readonly { file: string; source: string }[],
): Map<string, MockSource[]> {
  const discovered = new Map<string, MockSource[]>();
  for (const file of files) {
    const sourceFile = ts.createSourceFile(
      file.file,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      file.file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "page" &&
        node.expression.name.text === "route"
      ) {
        const routeArgument = node.arguments[0];
        if (routeArgument) {
          const pattern = routeArgument.getText(sourceFile);
          const rule = PROVIDER_ROUTE_RULES.find((candidate) =>
            candidate.matches(pattern),
          );
          if (rule) {
            const existing = discovered.get(rule.api) ?? [];
            existing.push({
              file: file.file,
              line:
                sourceFile.getLineAndCharacterOfPosition(
                  routeArgument.getStart(),
                ).line + 1,
              pattern,
            });
            discovered.set(rule.api, existing);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return discovered;
}

function discoverExternalApiMocks(): Map<string, MockSource[]> {
  return discoverExternalApiMocksFromSources(
    sourceFiles(UI_SMOKE_DIR).map((absolutePath) => ({
      file: path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"),
      source: readFileSync(absolutePath, "utf8"),
    })),
  );
}

describe("external API mock validation authority", () => {
  it("classifies every provider route fixture exactly once", () => {
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
      "Remove classifications whose provider route fixture no longer exists.",
    ).toEqual([]);
    expect(
      unclassified,
      "Every discovered external API mock needs validation artifacts or an exemption.",
    ).toEqual([]);
    expect(
      blankExemptions,
      "Every external API mock exemption must explain the current boundary.",
    ).toEqual([]);
    expect(
      [...new Set(classifications)].sort(),
      "The validation authority must exactly partition live provider routes.",
    ).toEqual([...discovered.keys()].sort());
  });

  it("discovers an untagged provider route directly from page.route", () => {
    const discovered = discoverExternalApiMocksFromSources([
      {
        file: "synthetic-provider.spec.ts",
        source:
          'await page.route("**/api/hyperliquid/new-provider-shape", async (route) => route.fulfill({ body: "{}" }));',
      },
    ]);

    expect(discovered.get("hyperliquid")).toEqual([
      {
        file: "synthetic-provider.spec.ts",
        line: 1,
        pattern: '"**/api/hyperliquid/new-provider-shape"',
      },
    ]);
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
