// Seeded launcher gesture-loop model for the mobile-native lanes (#12377, WI-8
// of #12179). The full web loop engine (WI-5, #12373) lives in packages/ui and
// runs a fast-check `fc.commands` model through CDP touch; that machinery is not
// reachable on a real device, where gestures are real OS `adb shell input`
// swipes/taps and the only readable state is the surface's `data-page` +
// sr-only AX probe. This module is the device-lane counterpart: a dependency-free
// seeded PRNG, the reachable slice of the §D [L] action alphabet, and a pure
// model that predicts the expected `data-page` after each action. The same LCG
// and alphabet are mirrored in the iOS LauncherGestureLoopUITests Swift harness
// so a printed ELIZA_LOOP_SEED reproduces the same action sequence on both
// platforms.
//
// #16764 replaced the two-page home/launcher rail with ONE combined home
// surface (HomeScreen + the embedded LauncherSurface grid). `data-page` is now
// static route intent — no gesture moves it — so the model's transition
// function is the identity: every action in the alphabet is a robustness fuzz
// action (it must not navigate, throw, wedge the surface, or ghost-launch a
// tile). The alphabet and weights are kept byte-identical to the rail era so an
// old ELIZA_LOOP_SEED still reproduces the same physical gesture stream.

/** Surface page — static route intent, mirrored to `data-page` ("/" = home). */
export type LauncherPage = "home" | "launcher";

/** Kinds of action in the reachable device-lane alphabet. All are
 *  navigation-inert on the combined surface; the names describe the physical
 *  gesture, kept from the rail era for seed-stream compatibility. */
export type LauncherLoopActionKind =
  | "swipe-left" // full-length horizontal drag left — must NOT navigate
  | "swipe-right" // full-length horizontal drag right — must NOT navigate
  | "sub-threshold-swipe-left" // short left drag — must NOT navigate
  | "sub-threshold-swipe-right" // short right drag — must NOT navigate
  | "vertical-scroll" // vertical drag — scrolls the home column, never navigates
  | "tap-center"; // a plain tap on a neutral region — never navigates

export interface LauncherLoopAction {
  readonly kind: LauncherLoopActionKind;
  /** The `data-page` expected AFTER this action, given the page before it. */
  readonly expectedPageAfter: LauncherPage;
}

/**
 * Deterministic 32-bit LCG (Numerical Recipes constants). Chosen over
 * `Math.random` so a seed reproduces the exact action stream, and over a
 * crypto/xorshift so the trivial integer arithmetic is byte-for-byte
 * re-implementable in the Swift lane. `next()` returns a float in [0, 1).
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Fold to an unsigned 32-bit non-zero state (0 would freeze the LCG).
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    // state = (1664525 * state + 1013904223) mod 2^32, via Math.imul to keep
    // the multiply in 32-bit space exactly as the Swift `&*` overflow multiply.
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  /** Uniform integer in [0, boundExclusive). */
  int(boundExclusive: number): number {
    return Math.floor(this.next() * boundExclusive);
  }
}

/**
 * Resolve the loop seed: an explicit `ELIZA_LOOP_SEED` (honored for
 * reproduction) or a fresh 31-bit seed. Always returned so the caller can print
 * it — every loop run must advertise the seed that reproduces it.
 */
export function resolveLoopSeed(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ELIZA_LOOP_SEED;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed >>> 0;
    throw new Error(
      `ELIZA_LOOP_SEED must be an integer, got ${JSON.stringify(raw)}`,
    );
  }
  return (Math.floor(Math.random() * 0x7fff_ffff) + 1) >>> 0;
}

// Weighted alphabet: horizontal drags dominate (they are the gestures that
// used to navigate, so they are the highest-risk regressions), with short
// drags, scrolls, and taps mixed in. Weights are integers so the pick is a
// plain cumulative walk that the Swift lane mirrors exactly; do not reorder or
// reweigh without updating the Swift mirror — it breaks seed reproduction.
const ACTION_WEIGHTS: ReadonlyArray<readonly [LauncherLoopActionKind, number]> =
  [
    ["swipe-left", 5],
    ["swipe-right", 5],
    ["sub-threshold-swipe-left", 2],
    ["sub-threshold-swipe-right", 2],
    ["vertical-scroll", 2],
    ["tap-center", 1],
  ];

const TOTAL_WEIGHT = ACTION_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

function pickKind(rng: SeededRandom): LauncherLoopActionKind {
  let roll = rng.int(TOTAL_WEIGHT);
  for (const [kind, weight] of ACTION_WEIGHTS) {
    if (roll < weight) return kind;
    roll -= weight;
  }
  // Unreachable: `roll` is always < TOTAL_WEIGHT. Kept explicit rather than a
  // non-null assertion so the function is total.
  return ACTION_WEIGHTS[ACTION_WEIGHTS.length - 1][0];
}

/**
 * Pure transition: on the combined home surface (#16764) NO gesture moves the
 * page — `data-page` is static route intent, and horizontal swipes are
 * navigation-inert. The identity transition is kept as the single model seam
 * so the device lanes assert "no action ever changes the page" explicitly
 * (a ghost tile launch unmounts the surface and diverges from this model).
 */
export function nextPage(
  _kind: LauncherLoopActionKind,
  before: LauncherPage,
): LauncherPage {
  return before;
}

/**
 * Generate `count` actions from `seed`, threading the modelled page through the
 * sequence so each action carries the page it must leave the surface on. The
 * returned page state at the end is `actions.at(-1)?.expectedPageAfter`.
 */
export function generateLauncherLoop(
  seed: number,
  count: number,
  startPage: LauncherPage = "home",
): LauncherLoopAction[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(
      `loop action count must be a positive integer, got ${count}`,
    );
  }
  const rng = new SeededRandom(seed);
  const actions: LauncherLoopAction[] = [];
  let page = startPage;
  for (let i = 0; i < count; i += 1) {
    const kind = pickKind(rng);
    page = nextPage(kind, page);
    actions.push({ kind, expectedPageAfter: page });
  }
  return actions;
}
