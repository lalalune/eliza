/**
 * TEMPORARY probe spec — deep-link /phone-companion against a fresh renderer
 * build and trace exactly what happens to the app-shell page registry.
 * DELETE BEFORE MERGE.
 */
import { test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";

test("probe phone-companion deep link", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleLines: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (consoleLines.length < 400) {
      consoleLines.push(`[${message.type()}] ${text.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (error) => {
    consoleLines.push(`[pageerror] ${String(error).slice(0, 500)}`);
  });
  await page.addInitScript(() => {
    const docId = Math.random().toString(36).slice(2, 7);
    console.log(`[probe] document start ${docId} ${location.href}`);
    let storesValue: unknown;
    Object.defineProperty(globalThis, "__ELIZA_UI_REGISTRY_STORES__", {
      configurable: true,
      get() {
        return storesValue;
      },
      set(next) {
        console.log(
          `[probe] ${docId} STORES SET (was ${storesValue === undefined ? "undefined" : "present"})`,
        );
        storesValue = next;
      },
    });
    const poll = () => {
      try {
        const stores = storesValue as
          | Map<string, { entries?: Map<string, unknown>; version?: number }>
          | undefined;
        const store = stores?.get("app-shell-pages");
        console.log(
          `[probe] ${docId} poll v=${store?.version ?? "-"} pages=${
            store?.entries ? [...store.entries.keys()].join(",") : "-"
          }`,
        );
      } catch (error) {
        console.log(`[probe] ${docId} poll error ${String(error)}`);
      }
      setTimeout(poll, 1_000);
    };
    setTimeout(poll, 500);
  });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await page.goto("/phone-companion", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(20_000);
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log("PROBE console:", JSON.stringify(consoleLines, null, 1));
  console.log("PROBE body text START >>>");
  console.log(bodyText.slice(0, 800));
  console.log("<<< PROBE body text END");
});
