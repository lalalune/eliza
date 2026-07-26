/**
 * Statically proves that every production provider-dispatch primitive has an
 * explicit boundary classification; no provider or public bypass is mocked.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  PROVIDER_DISPATCH_INVENTORY,
  type ProviderDispatchInventoryEntry,
} from "../test/provider-dispatch-inventory";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const DISPATCH_SIGNAL =
  /\b(?:generateText|streamText|generateObject|embed|embedMany)\s*\(|\.(?:chatCompletions|speechToText|textToSpeech|generate)\s*\(|\bcreateRouteHandler\s*\(|\bOPENAI_MODERATIONS_URL\b|\bELEVENLABS_API\b|https:\/\/api\.elevenlabs\.io|https:\/\/api\.openai\.com|https:\/\/api\.deepgram\.com|wss:\/\/api\.deepgram\.com|https:\/\/api\.cartesia\.ai|wss:\/\/api\.cartesia\.ai|\bnew\s+ElevenLabsClient\s*\(|\bcreateWorker(?:Cartesia|Deepgram)\w*Factory\s*\(/;
const PROVIDER_ADAPTER_SIGNAL =
  /\bfetch\s*\(|\bproviderFetchWithTimeout\s*\(|\bfal\.(?:subscribe|queue\.)|\bcreate(?:OpenAI|Anthropic|GatewayProvider)\s*\(|\bgenerate:\s*generate[A-Z]\w*/;
const SCAN_ROOTS = [
  {
    path: resolve(REPO_ROOT, "packages/cloud/api"),
    signal: DISPATCH_SIGNAL,
  },
  {
    path: resolve(REPO_ROOT, "packages/cloud/shared/src/lib/services"),
    signal: DISPATCH_SIGNAL,
  },
  {
    path: resolve(REPO_ROOT, "packages/cloud/shared/src/lib/api/a2a"),
    signal: DISPATCH_SIGNAL,
  },
  {
    path: resolve(REPO_ROOT, "packages/cloud/shared/src/lib/providers"),
    signal: PROVIDER_ADAPTER_SIGNAL,
  },
];

function isProductionTypeScript(path: string): boolean {
  return (
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".d.ts") &&
    !path.includes("/__tests__/") &&
    !path.includes("/test/") &&
    !path.includes("/src/stubs/") &&
    !path.endsWith("/src/_router.generated.ts")
  );
}

function walk(path: string): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (statSync(child).isDirectory()) {
      if (
        name === "node_modules" ||
        name === "__tests__" ||
        name === "test" ||
        name === "stubs" ||
        name.startsWith(".")
      ) {
        continue;
      }
      paths.push(...walk(child));
    } else if (isProductionTypeScript(child)) {
      paths.push(child);
    }
  }
  return paths;
}

function discoveredDispatchSources(): string[] {
  return SCAN_ROOTS.flatMap(({ path, signal }) =>
    walk(path).filter((source) => signal.test(readFileSync(source, "utf8"))),
  )
    .map((path) => relative(REPO_ROOT, path))
    .sort();
}

function inventoryEntries(): Array<[string, ProviderDispatchInventoryEntry]> {
  return Object.entries(PROVIDER_DISPATCH_INVENTORY).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

describe("provider dispatch architecture inventory", () => {
  test("discovers exactly the reviewed provider-dispatch sources", () => {
    expect(discoveredDispatchSources()).toEqual(
      inventoryEntries().map(([path]) => path),
    );
  });

  test("cache-admitted public inference owns auth, admission, and final dispatch checks", () => {
    const cacheAdmitted = inventoryEntries().filter(
      ([, entry]) => entry.boundary === "cache_admission",
    );

    for (const [path] of cacheAdmitted) {
      const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
      const delegatesToElizaAppBoundary = source.includes(
        "runElizaAppTextInference",
      );
      expect(
        source.includes("resolveInferenceAuthContext") ||
          delegatesToElizaAppBoundary,
      ).toBe(true);
      expect(
        source.includes("admitOrganizationInference") ||
          source.includes("admitAppInferenceCacheOnly") ||
          delegatesToElizaAppBoundary,
      ).toBe(true);
      expect(
        source.includes("markProviderDispatched") ||
          delegatesToElizaAppBoundary,
      ).toBe(true);
      expect(source).not.toContain("creditsService.reserve(");
    }
  });

  test("the known synchronous user-request set is exact and cannot grow silently", () => {
    const synchronous = inventoryEntries()
      .filter(([, entry]) => entry.boundary === "user_request_synchronous")
      .map(([path]) => path);

    expect(synchronous).toEqual([
      "packages/cloud/api/elevenlabs/voices/verify/[id]/route.ts",
      "packages/cloud/api/fal/proxy/route.ts",
      "packages/cloud/api/v1/apps/[id]/generate-image/route.ts",
      "packages/cloud/api/v1/generate-image/route.ts",
      "packages/cloud/api/v1/generate-music/route.ts",
      "packages/cloud/api/v1/generate-sfx/route.ts",
      "packages/cloud/api/v1/generate-video/route.ts",
      "packages/cloud/api/v1/voice/clone/route.ts",
      "packages/cloud/api/v1/voice/session/ws/route.ts",
      "packages/cloud/api/v1/voice/stt/route.ts",
      "packages/cloud/api/v1/voice/tts/route.ts",
      "packages/cloud/shared/src/lib/services/app-promotion-assets.ts",
      "packages/cloud/shared/src/lib/services/app-promotion.ts",
      "packages/cloud/shared/src/lib/services/discord-automation/app-automation.ts",
      "packages/cloud/shared/src/lib/services/seo.ts",
      "packages/cloud/shared/src/lib/services/telegram-automation/app-automation.ts",
      "packages/cloud/shared/src/lib/services/twitter-automation/app-automation.ts",
    ]);
  });

  test("latent provider code remains explicitly classified and absent from Worker routes", () => {
    const latent = inventoryEntries()
      .filter(([, entry]) => entry.boundary === "latent_unwired")
      .map(([path]) => path);

    expect(latent).toEqual(["packages/cloud/shared/src/lib/api/a2a/skills.ts"]);

    const productionApiSources = walk(
      resolve(REPO_ROOT, "packages/cloud/api"),
    ).map((path) => readFileSync(path, "utf8"));
    expect(
      productionApiSources.some((source) =>
        /lib\/api\/a2a(?:\/(?:index|handlers|skills))?["']/.test(source),
      ),
    ).toBe(false);
  });

  test("inventory entries remain actionable and point at real sources", () => {
    for (const [path, entry] of inventoryEntries()) {
      expect(statSync(resolve(REPO_ROOT, path)).isFile()).toBe(true);
      expect(entry.entrypoints).not.toEqual([]);
      expect(entry.rationale.trim()).not.toBe("");
    }
  });
});
