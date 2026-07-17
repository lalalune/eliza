/**
 * Playwright UI-smoke spec for the Plugin Views Lifecycle app flow using the
 * real renderer fixture.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { DYNAMIC_VIEW_CASES, type ViewCase } from "./plugin-view-cases";

async function expectLoadedView(page: Page, view: ViewCase, phase: string) {
  const viewRoot = page.locator("main").first();
  await expect(viewRoot).toBeVisible({ timeout: 60_000 });
  const readyView = viewRoot.locator(
    `[data-testid="dynamic-view-loader"][data-view-id="${view.id}"][data-view-type="${view.viewType}"][data-view-loader-state="mounted"]`,
  );
  await expect(
    readyView,
    `${view.id} ${view.viewType} should load during ${phase}`,
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Loading view/)).toHaveCount(0);
  await expect(page.getByText("Failed to load view")).toHaveCount(0);
  await expectNoRenderTelemetryErrors(
    page,
    `${view.id} ${view.viewType} ${phase}`,
  );
}

async function expectLauncherPage(page: Page) {
  const main = page.locator("main").first();
  await expect(main.getByTestId("launcher")).toBeVisible();
  await expect(
    main.locator('[data-testid^="launcher-tile-"]').first(),
  ).toBeVisible();
  await expect(main.getByText("dynamic view smoke surface")).toHaveCount(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function installDynamicViewHarnessRoute(
  page: Page,
  view: ViewCase,
): Promise<string> {
  // A unique nested path bypasses builtin and in-process app registrations that
  // intentionally own the plugin's public route. Rewriting the server's real
  // declaration keeps the production router and loader path under test.
  const harnessPath = `/apps/__lifecycle/${encodeURIComponent(view.id)}`;
  await page.route(
    (url) => url.pathname === "/api/views",
    async (route) => {
      const response = await route.fetch();
      const payload: unknown = await response.json();
      if (!isRecord(payload) || !Array.isArray(payload.views)) {
        throw new Error("View registry fixture must return a views array");
      }
      let matched = false;
      const views = payload.views.map((entry) => {
        if (!isRecord(entry) || entry.id !== view.id) return entry;
        matched = true;
        return { ...entry, path: harnessPath };
      });
      if (!matched) {
        throw new Error(`View registry fixture is missing "${view.id}"`);
      }
      await route.fulfill({ response, json: { ...payload, views } });
    },
  );
  return harnessPath;
}

test.describe("registered plugin view lifecycle coverage", () => {
  test("loader matrix matches every declaration served by /api/views", async ({
    page,
  }) => {
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/views");

    const registryIds = await page.evaluate(async () => {
      const response = await fetch("/api/views");
      if (!response.ok) {
        throw new Error(`View registry returned HTTP ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("views" in payload) ||
        !Array.isArray(payload.views)
      ) {
        throw new Error("View registry payload must contain a views array");
      }
      return payload.views.map((entry: unknown) => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("id" in entry) ||
          typeof entry.id !== "string"
        ) {
          throw new Error("Every view registry entry must have a string id");
        }
        return entry.id;
      });
    });

    expect([...new Set(registryIds)].sort()).toEqual(
      DYNAMIC_VIEW_CASES.map(({ id }) => id).sort(),
    );
  });

  for (const view of DYNAMIC_VIEW_CASES) {
    test(`${view.id} ${view.viewType} loads, unmounts, reopens, and reloads cleanly`, async ({
      page,
    }) => {
      installPageDiagnosticsGuard(page);
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      const harnessPath = await installDynamicViewHarnessRoute(page, view);

      await openAppPath(page, harnessPath);
      await expectLoadedView(page, view, "initial open");

      await openAppPath(page, "/views");
      await expectLauncherPage(page);
      await expectNoRenderTelemetryErrors(
        page,
        `${view.id} ${view.viewType} after unmount`,
      );

      await openAppPath(page, harnessPath);
      await expectLoadedView(page, view, "reopen");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expectLoadedView(page, view, "browser reload");
      await expectNoPageDiagnostics(
        page,
        `${view.id} ${view.viewType} lifecycle`,
      );
    });
  }
});
