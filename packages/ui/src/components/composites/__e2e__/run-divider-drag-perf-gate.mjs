/**
 * Divider-drag PERF GATE (perf/divider-drag-fps): drives an identical staged
 * pointer drag on two resize dividers over a byte-identical heavy body — the
 * pre-fix handler pattern (setState + synchronous localStorage per pointermove,
 * inline width → per-event reflow) vs the shipped pattern (rAF-coalesced ref
 * write, one state + storage commit on release) — and reports the REAL
 * PerformanceObserver frame stats plus the render-commit and localStorage-write
 * counts each produced. Four counterbalanced windows per implementation feed
 * the shared absolute frame-budget detector; majority gating rejects one noisy
 * host interval without allowing an equally slow legacy run to mask jank.
 *
 * The gate asserts the fix's mechanical contract in a real browser: the legacy
 * divider writes storage on (nearly) every pointer event and re-renders the
 * heavy body per event, while the shipped divider writes storage exactly ONCE
 * (on release), never re-renders the body mid-drag, and stays within the shared
 * absolute frame budget in a majority of independent measurement windows.
 *
 * Run: bun run --cwd packages/ui test:divider-drag-perf-gate
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBrowserFixtureE2E,
  stubElizaCore,
  stubNodeBuiltins,
} from "../../../testing/e2e-runner/index.ts";
import {
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "../../../hooks/frame-budget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-divider-perf");
const TRIAL_COUNT = 4;
// Headless 60Hz frame deltas quantize near 16.7/33.3/50ms. A 2.5× p95
// allowance sits between a single delayed frame and sustained multi-frame jank;
// the dropped-frame ratio remains the primary signal across refresh rates.
const FRAME_GATE = {
  p95BudgetFactor: 2.5,
  droppedFrameRatio: 0.2,
  reportOnLongTask: false,
};

// rAF frame sampler installed before the app boots: every painted frame's
// inter-frame delta lands in a window global for the shared detector.
const OBSERVER_INIT = `
(() => {
  const w = window;
  if (w.__FRAMES__) return;
  w.__FRAMES__ = [];
  let last = null;
  const tick = (now) => {
    if (last !== null) w.__FRAMES__.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

/**
 * Staged real pointer drag on a divider handle by `dx` px, `steps` moves paced
 * `stepMs` apart, so the browser paints frames between moves (a synchronous
 * burst would land in one frame and hide the reflow cost).
 */
async function dragHandle(p, testId, dx, { steps = 40, stepMs = 8 } = {}) {
  const box = await p.getByTestId(testId).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await p.mouse.move(cx + (dx * i) / steps, cy);
    await p.waitForTimeout(stepMs);
  }
  await p.mouse.up();
  await p.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => r(null))),
  );
}

async function measure(p, testId, dx) {
  await p.evaluate(() => {
    window.__FRAMES__ = [];
  });
  // Full drag sweep: in and back out so the divider actually resizes the heavy
  // body across a wide range.
  await dragHandle(p, testId, dx);
  await dragHandle(p, testId, -dx);
  const frames = await p.evaluate(() => window.__FRAMES__ ?? []);
  return summarizeFrameSamples(frames);
}

const fmt = (s) =>
  `fps ${s.fps.toFixed(1)} | p95 ${s.p95FrameMs.toFixed(1)}ms | worst ${s.worstFrameMs.toFixed(1)}ms | dropped ${s.droppedFrames}/${s.sampleCount}`;

function medianNumber(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

// Video encoding is deliberately absent from this performance harness: it is
// not product work and turns encoder throughput into false divider regressions.
await runBrowserFixtureE2E(
  {
    page: {
      entry: join(here, "divider-drag-perf-fixture.tsx"),
      outDir,
      htmlName: "divider-drag-perf.html",
      title: "divider drag perf gate",
      plugins: [stubElizaCore(), stubNodeBuiltins()],
      processShim: true,
      background: "#08080d",
      headHtml: `<script>${OBSERVER_INIT}</script>`,
    },
    context: { viewport: { width: 1280, height: 900 } },
    waitFor: '[data-testid="divider-perf-root"]',
    passMessage: "\nDIVIDER PERF GATE PASSED",
    failMessage: "\nDIVIDER PERF GATE FAILED",
  },
  async ({ page, gate }) => {
    const check = gate.assert;

    // Reset counters after mount so only the drag windows are measured.
    await page.evaluate(() => {
      window.__DIVIDER_METRICS__ = {
        legacyRenders: 0,
        shippedRenders: 0,
        legacyStorageWrites: 0,
        shippedStorageWrites: 0,
      };
    });

    // Left-drag +200 grows each bar (handle on the left edge); the reverse
    // drag shrinks it back. 40 paced moves each way = ~80 pointer events. Swap
    // order between trials so time-dependent runner load cannot always penalize
    // the same implementation.
    const legacyWindows = [];
    const shippedWindows = [];
    for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
      const legacyFirst = trial === 0 || trial === TRIAL_COUNT - 1;
      const order =
        legacyFirst
          ? [
              ["legacy", "legacy-handle", legacyWindows],
              ["shipped", "shipped-handle", shippedWindows],
            ]
          : [
              ["shipped", "shipped-handle", shippedWindows],
              ["legacy", "legacy-handle", legacyWindows],
            ];
      for (const [label, testId, windows] of order) {
        const summary = await measure(page, testId, 200);
        windows.push(summary);
        console.log(
          `${label.padEnd(7)} divider [${trial + 1}/${TRIAL_COUNT}]: ${fmt(summary)}`,
        );
      }
    }

    const metrics = await page.evaluate(() => window.__DIVIDER_METRICS__);
    const legacyP95 = medianNumber(
      legacyWindows.map((window) => window.p95FrameMs),
    );
    const shippedP95 = medianNumber(
      shippedWindows.map((window) => window.p95FrameMs),
    );
    const shippedFlagged = shippedWindows.filter((window) =>
      shouldReportFrameBudget(window, FRAME_GATE),
    ).length;

    console.log(
      `\nmedian p95 — legacy ${legacyP95.toFixed(1)}ms | shipped ${shippedP95.toFixed(1)}ms`,
    );
    console.log(
      `shipped frame-budget windows flagged — ${shippedFlagged}/${TRIAL_COUNT}`,
    );
    console.log(
      `body re-renders during ${TRIAL_COUNT * 2} drags — legacy ${metrics.legacyRenders} | shipped ${metrics.shippedRenders}`,
    );
    console.log(
      `localStorage writes during ${TRIAL_COUNT * 2} drags — legacy ${metrics.legacyStorageWrites} | shipped ${metrics.shippedStorageWrites}\n`,
    );
    await page.screenshot({ path: join(outDir, "divider-perf-final.png") });

    check(
      [...legacyWindows, ...shippedWindows].every(
        (window) => window.sampleCount > 20,
      ),
      `captured ${TRIAL_COUNT} meaningful frame windows per implementation`,
    );
    // The fix's core contract, proven in a real browser:
    check(
      metrics.shippedStorageWrites === TRIAL_COUNT * 2,
      `shipped divider persists exactly once per drag (${TRIAL_COUNT * 2} drags → ${metrics.shippedStorageWrites} writes)`,
    );
    check(
      metrics.legacyStorageWrites > metrics.shippedStorageWrites * 4,
      `legacy divider persisted on ~every event (${metrics.legacyStorageWrites} writes vs ${metrics.shippedStorageWrites})`,
    );
    check(
      metrics.shippedRenders <= TRIAL_COUNT * 2,
      `shipped divider re-renders the heavy body only on release, once per drag (${TRIAL_COUNT * 2} drags → ${metrics.shippedRenders} renders)`,
    );
    check(
      metrics.legacyRenders > 20 * TRIAL_COUNT,
      `legacy divider re-rendered the heavy body per event (${metrics.legacyRenders})`,
    );
    // Absolute smoothness prevents a both-janky A/B run from passing merely
    // because legacy was equally slow. One noisy host interval is tolerated,
    // while at least half the independent windows breaching the shared detector
    // fails the lane.
    check(
      shippedFlagged < TRIAL_COUNT / 2,
      `shipped divider stays within the absolute frame budget in a majority of windows (${shippedFlagged}/${TRIAL_COUNT} flagged, median p95 ${shippedP95.toFixed(1)}ms)`,
    );
  },
);
