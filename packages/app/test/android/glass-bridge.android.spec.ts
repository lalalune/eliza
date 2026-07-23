/**
 * On-device contract for the Android GlassBridge plugin against the real
 * installed APK: native-view lifecycle (insert / replace-on-reattach / animated
 * move / detach) read back from the actual View objects, adversarial rect
 * rejection at the untrusted boundary, and pixel captures proving the tinted
 * native material renders through a real transparency hole.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { expect, test } from "./android-harness";

type RegionState = {
  exists: boolean;
  regionCount: number;
  attachedBelowWebView?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
};

type GlassPlugin = {
  isAvailable(): Promise<{ available: boolean }>;
  reset(): Promise<void>;
  setBackdrop(o: unknown): Promise<{ applied: boolean }>;
  clearBackdrop(): Promise<void>;
  attachGlass(o: unknown): Promise<{ attached: boolean }>;
  updateRect(o: unknown): Promise<void>;
  detachGlass(o: unknown): Promise<void>;
  getRegionState(o: unknown): Promise<RegionState>;
};

const ARTIFACT_DIR = path.join(
  process.cwd(),
  "test-results",
  "android-glass-bridge",
);

function adb(args: string[], serial: string): Buffer {
  return execFileSync(adbBin(), ["-s", serial, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function adbBin(): string {
  return process.env.ANDROID_HOME
    ? `${process.env.ANDROID_HOME}/platform-tools/adb`
    : "adb";
}

async function selectorDevicePoint(page: import("@playwright/test").Page) {
  // Start on the painted bar itself. The button's broad pseudo-element hit
  // target extends above the visible handle and its DOM box can fall outside
  // the active native-touch strip on tall Android viewports.
  const grabber = page.getByTestId("chat-sheet-grabber");
  const box =
    (await grabber.locator("span").boundingBox()) ??
    (await grabber.boundingBox());
  if (!box) throw new Error("chat sheet grabber has no device geometry");
  const metrics = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
  }));
  return {
    x: Math.round((box.x + box.width / 2 + metrics.offsetLeft) * metrics.dpr),
    // The broad handle intentionally accepts a swipe that begins just below
    // the painted bar as well. This keeps the device coordinate inside the
    // WebView's active hit strip when Android's status-bar inset is not
    // reflected in visualViewport.offsetTop.
    y: Math.round(
      (box.y + box.height / 2 + metrics.offsetTop + 50) * metrics.dpr,
    ),
    dpr: metrics.dpr,
  };
}

function swipeInFlight(
  serial: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
): Promise<void> {
  const child = spawn(
    adbBin(),
    [
      "-s",
      serial,
      "shell",
      "input",
      "swipe",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(durationMs),
    ],
    { stdio: "ignore" },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`adb swipe exited ${String(code)}`));
    });
  });
}

/** Mean RGB of a device-pixel rect inside a screencap PNG (2px sampling). */
function meanRgb(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(png.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(png.height, Math.round(rect.y + rect.height));
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (png.width * y + x) * 4;
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}

test("product chat surface uses native Material at rest and CSS while moving", async ({
  device,
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const serial = device.serial();

  // This visual/material leg needs the offline shell, not an agent. A
  // backendless debug APK intentionally offers an explicit "Open App" route.
  const openApp = page.getByText("Open App", { exact: true });
  if (await openApp.isVisible().catch(() => false)) await openApp.click();
  const skipSetup = page.getByText("Skip for now", { exact: true });
  if (await skipSetup.isVisible().catch(() => false)) await skipSetup.click();

  const detent = page.getByTestId("chat-detent-probe");
  const tier = page.getByTestId("chat-glass-tier-probe");
  await expect(detent).toContainText("chat-detent:", { timeout: 60_000 });

  // A real device swipe opens the product sheet from its settled input state.
  const collapsedPoint = await selectorDevicePoint(page);
  adb(
    [
      "shell",
      "input",
      "swipe",
      String(collapsedPoint.x),
      String(collapsedPoint.y),
      String(collapsedPoint.x),
      String(collapsedPoint.y - Math.round(300 * collapsedPoint.dpr)),
      "100",
    ],
    serial,
  );
  await expect(detent).not.toContainText("chat-detent:collapsed", {
    timeout: 15_000,
  });
  await expect(detent).toContainText("chat-detent:full", {
    timeout: 15_000,
  });
  await expect(tier).toContainText("chat-glass-tier:native", {
    timeout: 15_000,
  });
  await testInfo.attach("android-chat-native-rest.png", {
    body: adb(["exec-out", "screencap", "-p"], serial),
    contentType: "image/png",
  });

  // Hold a second REAL touch drag in flight. The React gate must switch to CSS
  // before the gesture is released; querying only after `adb input swipe`
  // returns would miss the transient state this contract is about.
  const restPoint = await selectorDevicePoint(page);
  const fullToHalfCss = await page.evaluate(() => {
    const thread = document.querySelector("#continuous-thread");
    if (!(thread instanceof HTMLElement)) {
      throw new Error("open chat thread has no device geometry");
    }
    return Math.max(
      1,
      thread.getBoundingClientRect().height - window.innerHeight * 0.46,
    );
  });
  await testInfo.attach("android-chat-drag-coordinates.json", {
    body: Buffer.from(
      JSON.stringify({ collapsedPoint, restPoint, fullToHalfCss }, null, 2),
    ),
    contentType: "application/json",
  });
  await page.evaluate(() => {
    const probe = document.querySelector(
      '[data-testid="chat-glass-tier-probe"]',
    );
    if (!probe) throw new Error("chat glass tier probe disappeared");
    const state = window as unknown as { __glassTierHistory: string[] };
    state.__glassTierHistory = [probe.textContent ?? ""];
    new MutationObserver(() => {
      state.__glassTierHistory.push(probe.textContent ?? "");
    }).observe(probe, { childList: true, characterData: true, subtree: true });
  });
  const moving = swipeInFlight(
    serial,
    restPoint,
    {
      x: restPoint.x,
      y: restPoint.y + Math.round(fullToHalfCss * restPoint.dpr),
    },
    4_000,
  );
  const midDragCapture = new Promise<Buffer>((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(adb(["exec-out", "screencap", "-p"], serial));
      } catch (error) {
        reject(error);
      }
    }, 2_000);
  });
  await moving;
  const tierHistory = await page.evaluate(
    () =>
      (
        window as unknown as {
          __glassTierHistory?: string[];
        }
      ).__glassTierHistory ?? [],
  );
  expect(
    tierHistory.some((value) => value.includes("chat-glass-tier:css-")),
  ).toBe(true);
  expect(
    tierHistory.some((value) => value.includes("chat-glass-gate:o1s0d1")),
  ).toBe(true);
  await testInfo.attach("android-chat-css-mid-drag.png", {
    body: await midDragCapture,
    contentType: "image/png",
  });
  // Release onto HALF rather than an arbitrary free-rest height: the native
  // contract is specifically for settled detents, and the long in-flight hold
  // above is independently what proves the moving CSS tier.
  await expect(detent).toContainText("chat-detent:half", {
    timeout: 15_000,
  });
  await expect(tier).toContainText("chat-glass-tier:native", {
    timeout: 15_000,
  });
  await testInfo.attach("android-chat-native-resettled.png", {
    body: adb(["exec-out", "screencap", "-p"], serial),
    contentType: "image/png",
  });
});

test("GlassBridge native-view lifecycle, boundary validation, and rendered pixels", async ({
  device,
  page,
}, testInfo) => {
  test.setTimeout(180_000);

  const serial = device.serial();
  const sdk = Number.parseInt(
    (await device.shell("getprop ro.build.version.sdk")).toString().trim(),
    10,
  );
  expect(Number.isFinite(sdk)).toBe(true);
  const expectedAvailable = sdk >= 31;

  const CSS_RECT = { x: 40, y: 200, width: 240, height: 180 };
  const MOVED_RECT = { x: 80, y: 320, width: 300, height: 220 };

  const boot = await page.evaluate(async (rect) => {
    const cap = (
      window as unknown as {
        Capacitor?: {
          registerPlugin?: (name: string) => unknown;
          Plugins?: Record<string, unknown>;
        };
      }
    ).Capacitor;
    const plugin = (
      cap?.registerPlugin
        ? cap.registerPlugin("GlassBridge")
        : cap?.Plugins?.GlassBridge
    ) as GlassPlugin | undefined;
    if (!plugin) return { error: "GlassBridge plugin not registered" } as const;
    (window as unknown as { __glass: GlassPlugin }).__glass = plugin;
    const availability = await plugin.isAvailable();
    // The product may already have anchored its chat surface before this
    // low-level probe attaches. Reset establishes a deterministic native-host
    // baseline and directly exercises the renderer-reload teardown contract.
    await plugin.reset();
    // Host a wallpaper below the WebView BEFORE the panel: bytes generated in
    // the page (canvas) and piped across the bridge — the contract has no
    // native network/cookie machinery, so no URL can exercise this path.
    const wallpaper = document.createElement("canvas");
    wallpaper.width = 64;
    wallpaper.height = 64;
    const wallpaperCtx = wallpaper.getContext("2d");
    if (wallpaperCtx) {
      wallpaperCtx.fillStyle = "#123456";
      wallpaperCtx.fillRect(0, 0, 64, 64);
    }
    const wallpaperDataUrl = wallpaper.toDataURL("image/png");
    const backdrop = await plugin.setBackdrop({
      imageBase64: wallpaperDataUrl.slice(wallpaperDataUrl.indexOf(",") + 1),
      color: "#002244",
    });
    // Bright saturated tint so the pixel capture proves the panel is OUR
    // native material, not the window background.
    const attach = await plugin.attachGlass({
      id: "e2e-probe",
      rect,
      cornerRadius: 24,
      colorScheme: "dark",
      tintColor: "#ff6600",
    });
    const afterAttach = await plugin.getRegionState({ id: "e2e-probe" });
    // Same-id reattach must REPLACE the region, never stack a second panel.
    const reattach = await plugin.attachGlass({
      id: "e2e-probe",
      rect,
      cornerRadius: 24,
      colorScheme: "dark",
      tintColor: "#ff6600",
    });
    const afterReattach = await plugin.getRegionState({ id: "e2e-probe" });
    return {
      availability,
      backdrop,
      attach,
      reattach,
      afterAttach,
      afterReattach,
      dpr: window.devicePixelRatio,
    };
  }, CSS_RECT);
  if ("error" in boot) throw new Error(String(boot.error));

  expect(boot.availability.available).toBe(expectedAvailable);
  expect(boot.backdrop.applied).toBe(expectedAvailable);
  expect(boot.attach.attached).toBe(expectedAvailable);
  expect(boot.reattach.attached).toBe(expectedAvailable);
  if (!expectedAvailable) return; // pre-31 device: CSS tier, nothing to render

  // Native truth: exactly one panel, inserted below the WebView, at the
  // device-pixel geometry the CSS rect maps to.
  const dpr = boot.dpr;
  expect(boot.afterAttach.exists).toBe(true);
  expect(boot.afterAttach.regionCount).toBe(1);
  expect(boot.afterAttach.attachedBelowWebView).toBe(true);
  expect(boot.afterAttach.rect?.width).toBeCloseTo(CSS_RECT.width * dpr, -1);
  expect(boot.afterAttach.rect?.height).toBeCloseTo(CSS_RECT.height * dpr, -1);
  expect(boot.afterReattach.regionCount).toBe(1);

  // Rendered pixels: hide the web layer so the page is a true transparency
  // hole, screencap, and prove the tinted native material shows through.
  await page.evaluate(() => {
    const root = document.getElementById("root");
    if (root) root.style.display = "none";
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  });
  await page.waitForTimeout(700);
  const attachedShot = PNG.sync.read(
    adb(["exec-out", "screencap", "-p"], serial),
  );
  // The panel offsets by the WebView's container position; its own reported
  // x/y are container coordinates. For the screen-space sample, use the REAL
  // panel geometry the plugin read back rather than re-deriving it.
  const attachedRect = boot.afterAttach.rect ?? {
    x: CSS_RECT.x * dpr,
    y: CSS_RECT.y * dpr,
    width: CSS_RECT.width * dpr,
    height: CSS_RECT.height * dpr,
  };
  const attachedColor = meanRgb(attachedShot, attachedRect);
  // The orange-tinted material must dominate red over blue; the bare window
  // background (black/neutral) cannot produce this.
  expect(attachedColor.r).toBeGreaterThan(attachedColor.b + 40);
  expect(attachedColor.r).toBeGreaterThan(60);

  // Animated move: the REAL view geometry must land on the new rect.
  const afterMove = await page.evaluate(async (rect) => {
    const plugin = (window as unknown as { __glass: GlassPlugin }).__glass;
    await plugin.updateRect({ id: "e2e-probe", rect });
    await new Promise((resolve) => setTimeout(resolve, 450)); // 150ms anim + slack
    return plugin.getRegionState({ id: "e2e-probe" });
  }, MOVED_RECT);
  expect(afterMove.exists).toBe(true);
  expect(afterMove.rect?.width).toBeCloseTo(MOVED_RECT.width * dpr, -1);
  expect(afterMove.rect?.height).toBeCloseTo(MOVED_RECT.height * dpr, -1);
  const containerOffsetX = (boot.afterAttach.rect?.x ?? 0) - CSS_RECT.x * dpr;
  const containerOffsetY = (boot.afterAttach.rect?.y ?? 0) - CSS_RECT.y * dpr;
  expect(afterMove.rect?.x).toBeCloseTo(
    MOVED_RECT.x * dpr + containerOffsetX,
    -1,
  );
  expect(afterMove.rect?.y).toBeCloseTo(
    MOVED_RECT.y * dpr + containerOffsetY,
    -1,
  );

  const movedShot = PNG.sync.read(adb(["exec-out", "screencap", "-p"], serial));
  const movedColor = meanRgb(movedShot, afterMove.rect ?? attachedRect);
  expect(movedColor.r).toBeGreaterThan(movedColor.b + 40);

  // Adversarial rects: every one must REJECT at the boundary (never clamp),
  // and none may disturb the live region.
  const adversarial = await page.evaluate(async () => {
    const plugin = (window as unknown as { __glass: GlassPlugin }).__glass;
    const bad = [
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0, y: 0, width: -50, height: 100 },
      { x: 0, y: 0, width: 100, height: Number.NaN },
      { x: Number.POSITIVE_INFINITY, y: 0, width: 100, height: 100 },
      { x: 0, y: 9e9, width: 100, height: 100 },
      { x: 0, y: 0, width: 5_000_000, height: 100 },
    ];
    const rejections: boolean[] = [];
    for (const rect of bad) {
      try {
        await plugin.updateRect({ id: "e2e-probe", rect });
        rejections.push(false);
      } catch {
        rejections.push(true);
      }
    }
    try {
      await plugin.attachGlass({ id: "bad", rect: bad[0], cornerRadius: 0 });
      rejections.push(false);
    } catch {
      rejections.push(true);
    }
    const state = await plugin.getRegionState({ id: "e2e-probe" });
    return { rejections, state };
  });
  expect(adversarial.rejections).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(adversarial.state.exists).toBe(true);
  expect(adversarial.state.regionCount).toBe(1);

  // Detach: the panel leaves the hierarchy, count drops to zero, and the
  // pixels no longer carry the tint.
  const afterDetach = await page.evaluate(async () => {
    const plugin = (window as unknown as { __glass: GlassPlugin }).__glass;
    await plugin.detachGlass({ id: "e2e-probe" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return plugin.getRegionState({ id: "e2e-probe" });
  });
  expect(afterDetach.exists).toBe(false);
  expect(afterDetach.regionCount).toBe(0);

  const detachedShot = PNG.sync.read(
    adb(["exec-out", "screencap", "-p"], serial),
  );
  const detachedColor = meanRgb(detachedShot, attachedRect);
  expect(detachedColor.r).toBeLessThan(attachedColor.r - 40);

  // Restore the web layer for subsequent specs.
  await page.evaluate(() => {
    const root = document.getElementById("root");
    if (root) root.style.display = "";
  });

  // Evidence artifacts: attached / moved / detached screencaps.
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const [name, shot] of [
    ["attached", attachedShot],
    ["moved", movedShot],
    ["detached", detachedShot],
  ] as const) {
    const file = path.join(ARTIFACT_DIR, `${name}.png`);
    writeFileSync(file, PNG.sync.write(shot));
    await testInfo.attach(name, { path: file, contentType: "image/png" });
  }
});
