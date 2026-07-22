/**
 * Exercises the authenticated app-catalog route against the canonical
 * first-party registry boundary and verifies its dashboard DTO mapping.
 */

import { EventEmitter } from "node:events";
import type http from "node:http";
import type { AppEntry } from "@elizaos/registry/first-party";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

const dependencies = vi.hoisted(() => ({
  ensureRouteAuthorized: vi.fn(async () => true),
  getApps: vi.fn(),
  loadRegistry: vi.fn(() => ({ registry: true })),
  resolveAppHeroImage: vi.fn(() => "/api/apps/hero/fallback"),
}));

vi.mock("@elizaos/agent", () => ({
  resolveAppHeroImage: dependencies.resolveAppHeroImage,
}));
vi.mock("@elizaos/registry/first-party", () => ({
  getApps: dependencies.getApps,
  loadRegistry: dependencies.loadRegistry,
}));
vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: dependencies.ensureRouteAuthorized,
}));

import { handleCatalogRoutes } from "./catalog-routes";

const state = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
} as CompatRuntimeState;

function request(method: string, url: string): http.IncomingMessage {
  return { method, url } as http.IncomingMessage;
}

function response(): http.ServerResponse & { body: string } {
  const res = new EventEmitter() as http.ServerResponse & { body: string };
  res.body = "";
  res.statusCode = 200;
  res.setHeader = vi.fn() as unknown as typeof res.setHeader;
  res.end = vi.fn((chunk?: string) => {
    res.body += chunk ?? "";
    return res;
  }) as unknown as typeof res.end;
  return res;
}

function app(overrides: Record<string, unknown> = {}): AppEntry {
  return {
    id: "notes",
    kind: "app",
    name: "Notes",
    subtype: "productivity",
    launch: {
      type: "server-launch",
      capabilities: ["notes:read"],
    },
    render: { visible: true },
    resources: {},
    ...overrides,
  } as unknown as AppEntry;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.ensureRouteAuthorized.mockResolvedValue(true);
  dependencies.loadRegistry.mockReturnValue({ registry: true });
  dependencies.resolveAppHeroImage.mockReturnValue("/api/apps/hero/fallback");
});

describe("GET /api/catalog/apps", () => {
  it("loads visible apps from the canonical registry and maps their DTOs", async () => {
    dependencies.getApps.mockReturnValue([
      app(),
      app({
        id: "hidden",
        name: "Hidden",
        render: { visible: false },
      }),
      app({
        id: "wallet",
        npmName: "@elizaos/app-wallet",
        name: "Wallet",
        description: "Inspect balances",
        version: "2.4.0",
        launch: {
          type: "external",
          url: "https://wallet.example",
          capabilities: ["wallet:read"],
          supports: { v0: false, v1: true, v2: true },
          npm: {
            package: "@elizaos/app-wallet-runtime",
            v1Version: "1.9.0",
            v2Version: "2.4.0",
          },
          viewer: "browser",
          uiExtension: "wallet-panel",
        },
        render: {
          visible: true,
          icon: "Wallet",
          heroImage: "/wallet-hero.png",
        },
        resources: { repository: "https://github.com/elizaOS/wallet" },
      }),
    ]);
    const res = response();

    await expect(
      handleCatalogRoutes(request("GET", "/api/catalog/apps"), res, state),
    ).resolves.toBe(true);

    expect(dependencies.loadRegistry).toHaveBeenCalledOnce();
    expect(dependencies.getApps).toHaveBeenCalledWith({ registry: true });
    expect(dependencies.resolveAppHeroImage).toHaveBeenCalledWith(
      "notes",
      null,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      expect.objectContaining({
        name: "notes",
        displayName: "Notes",
        description: "",
        launchType: "server",
        launchUrl: null,
        heroImage: "/api/apps/hero/fallback",
        repository: "",
        latestVersion: null,
        supports: { v0: false, v1: false, v2: true },
        npm: {
          package: "notes",
          v0Version: null,
          v1Version: null,
          v2Version: null,
        },
      }),
      expect.objectContaining({
        name: "@elizaos/app-wallet",
        displayName: "Wallet",
        launchType: "external",
        launchUrl: "https://wallet.example",
        heroImage: "/wallet-hero.png",
        latestVersion: "2.4.0",
        npm: {
          package: "@elizaos/app-wallet-runtime",
          v0Version: null,
          v1Version: "1.9.0",
          v2Version: "2.4.0",
        },
      }),
    ]);
  });

  it("stops at auth and ignores non-catalog or unsupported routes", async () => {
    dependencies.ensureRouteAuthorized.mockResolvedValue(false);
    const unauthorized = response();
    await expect(
      handleCatalogRoutes(
        request("GET", "/api/catalog/apps"),
        unauthorized,
        state,
      ),
    ).resolves.toBe(true);
    expect(dependencies.getApps).not.toHaveBeenCalled();

    await expect(
      handleCatalogRoutes(request("GET", "/api/apps"), response(), state),
    ).resolves.toBe(false);
    await expect(
      handleCatalogRoutes(
        request("POST", "/api/catalog/apps"),
        response(),
        state,
      ),
    ).resolves.toBe(false);
  });
});
