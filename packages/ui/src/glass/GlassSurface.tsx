/**
 * The one glass primitive every glassmorphic chrome element renders through:
 * `<GlassSurface variant="menu">…</GlassSurface>`. Picks the variant recipe
 * from `tokens.ts`, paints it at the best tier `useNativeGlass` reports, and
 * keeps the branded edge (rim ring + sheen + inset edge shadow) identical on
 * every tier — the tier only decides what produces the MATERIAL:
 *
 *   css tiers      — translucent fill + backdrop-filter on this element
 *                    (refraction upgrade on Chromium via `@supports`).
 *   native   — a real UIGlassEffect view is anchored below the WebView and the
 *                    element keeps its translucent fill as a foreground scrim.
 *                    A single WebView is one native compositing layer, so the
 *                    scrim prevents sibling DOM behind the surface from being
 *                    painted sharply above the native material. Rect syncs on
 *                    mount and resize — NOT per scroll frame, so this is for
 *                    stable chrome, never elements inside a scroller.
 *
 * `GlassStyles` mounts the shared stylesheet (rim pseudo-element + the
 * Chromium refraction upgrade) once per document, alongside
 * `LiquidGlassRefractionDefs`; the app shell renders it a single time.
 */

import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import {
  LiquidGlassRefractionDefs,
  liquidGlassRimCss,
} from "../components/shell/liquid-glass";
import {
  acquireNativeBackdrop,
  activateNativeBackdrop,
  isNativeBackdropActive,
  type NativeBackdropLease,
  releaseNativeBackdrop,
  setNativeGlassDiag,
  subscribeNativeBackdrop,
  useNativeBackdropActive,
} from "./native-backdrop";
import {
  glassBridge,
  isNativeGlassAvailable,
  nativeGlassPlatform,
} from "./native-bridge";
import { GLASS_RECIPES, type GlassVariant } from "./tokens";
import { cssGlassTier, type GlassTier } from "./useNativeGlass";

const VARIANTS = Object.keys(GLASS_RECIPES) as GlassVariant[];

/** Shared stylesheet: per-variant class + rim + Chromium refraction upgrade. */
export function GlassStyles(): React.JSX.Element {
  const css = VARIANTS.map((variant) => {
    const r = GLASS_RECIPES[variant];
    const base = `
.eliza-glass-${variant} {
  position: relative;
  background-color: ${r.background};
  background-image: ${r.sheen};
  box-shadow: ${r.edgeShadow};
  backdrop-filter: ${r.backdropFilter};
  -webkit-backdrop-filter: ${r.backdropFilter};
  border-radius: ${r.radius};
}
.eliza-glass-${variant}[data-glass-tier="native"] {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}`;
    const refraction = r.refraction
      ? `
@supports (backdrop-filter: url(#x)) {
  .eliza-glass-${variant}:not([data-glass-tier="native"]) {
    backdrop-filter: ${r.refraction};
    -webkit-backdrop-filter: ${r.refraction};
  }
}`
      : "";
    const rim = r.rim ? liquidGlassRimCss(`.eliza-glass-${variant}`) : "";
    return base + refraction + rim;
  }).join("\n");
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant CSS from tokens — no user input reaches it */}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <LiquidGlassRefractionDefs />
    </>
  );
}

export interface GlassSurfaceProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant: GlassVariant;
  /**
   * Forwarded to the native tier's UIGlassEffect (touch grow/shimmer).
   * Mount-time only — the system cannot toggle it on a live effect view.
   */
  interactive?: boolean;
}

export interface NativeGlassAnchorOptions {
  /** False releases the native material and reports a CSS tier immediately. */
  enabled?: boolean;
  /** UIGlassEffect.isInteractive — mount-time only (see GlassSurfaceProps). */
  interactive?: boolean;
}

/**
 * Anchor real native material to a STABLE element and report the tier the
 * element should paint. The whole native handoff is acknowledgement-ordered so
 * no frame ever lacks a material:
 *
 *   1. `acquireNativeBackdrop()` pipes the wallpaper below the WebView —
 *      invisible, the DOM still paints it — and holds a lease.
 *   2. `attachGlass` installs the region — still invisible for the same
 *      reason.
 *   3. Only after BOTH acks: `activateNativeBackdrop()` + local state flip in
 *      one React commit — the DOM wallpaper hides exactly when this element
 *      drops its CSS blur and the native stack shows through its fill.
 *
 * Disabling (`enabled: false` — e.g. a drag starting) reports a CSS tier on
 * the very same render; the caller repaints its CSS material instantly while
 * the native teardown trails harmlessly behind an opaque element.
 *
 * Both native implementations use this acknowledgement-ordered path. iOS
 * supplies UIGlassEffect and Android supplies its API-31+ dynamic-palette
 * Material panel; older OS versions and non-native platforms stay on CSS.
 * Android's material is intentionally near-opaque, but it still has to be the
 * native panel promised by the bridge contract rather than a CSS imitation.
 */
export function useNativeGlassAnchor(
  ref: React.RefObject<HTMLElement | null>,
  { enabled = true, interactive = false }: NativeGlassAnchorOptions = {},
): GlassTier {
  const regionId = useId();
  const [available, setAvailable] = useState(false);
  const [nativeLive, setNativeLive] = useState(false);
  const backdropActive = useNativeBackdropActive();

  useEffect(() => {
    let alive = true;
    void isNativeGlassAvailable().then((next) => {
      if (alive) setAvailable(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  const platform = nativeGlassPlatform();
  const wantNative = enabled && available && platform !== null;

  useEffect(() => {
    if (!wantNative) {
      // Disambiguate exactly which gate is holding the anchor on CSS —
      // e=caller-enabled, p=supported-native-platform, a=plugin-available.
      const platformOk = platform !== null;
      setNativeGlassDiag(
        `anchor-idle:e${enabled ? 1 : 0}p${platformOk ? 1 : 0}a${available ? 1 : 0}`,
      );
      return;
    }
    const el = ref.current;
    const bridge = glassBridge();
    if (!el || !bridge) {
      setNativeGlassDiag(el ? "anchor-no-bridge" : "anchor-no-element");
      return;
    }
    let alive = true;
    let lease: NativeBackdropLease | null = null;
    let attached = false;
    let observer: ResizeObserver | null = null;
    let unsubscribe: (() => void) | null = null;
    const rectOf = () => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const sync = () => {
      if (attached) void bridge.updateRect({ id: regionId, rect: rectOf() });
    };
    // Idempotent (flag-guarded): runs from effect cleanup AND from the store
    // subscription when the backdrop force-deactivates under us (wallpaper
    // switched to a shader while anchored). Our own release re-notifies the
    // store, which re-enters here as a no-op.
    const teardown = () => {
      observer?.disconnect();
      observer = null;
      window.removeEventListener("resize", sync);
      if (attached) {
        attached = false;
        void bridge.detachGlass({ id: regionId });
      }
      if (lease) {
        const heldLease = lease;
        lease = null;
        releaseNativeBackdrop(heldLease);
      }
      setNativeLive(false);
    };
    void (async () => {
      const acquired = await acquireNativeBackdrop();
      if (!acquired) return; // no image wallpaper / native refused → stay CSS
      lease = acquired;
      if (!alive) {
        teardown();
        return;
      }
      const radius = Number.parseFloat(getComputedStyle(el).borderRadius) || 12;
      let ok = false;
      try {
        ok = (
          await bridge.attachGlass({
            id: regionId,
            rect: rectOf(),
            cornerRadius: radius,
            interactive,
          })
        ).attached;
      } catch {
        // error-policy:J4 capability write — an old shell without attachGlass
        // support degrades to the CSS tier below, never a transparent hole.
        ok = false;
      }
      if (ok) attached = true;
      if (!alive || !ok) {
        if (!ok) setNativeGlassDiag("native-refused-region");
        teardown();
        return;
      }
      // Atomic promotion: the wallpaper may have changed while attachGlass
      // was in flight, in which case the pixels native holds are stale and
      // activation refuses the lease — stay CSS rather than flash them.
      if (!activateNativeBackdrop(acquired)) {
        teardown();
        return;
      }
      setNativeGlassDiag("native-anchored");
      setNativeLive(true);
      unsubscribe = subscribeNativeBackdrop(() => {
        if (!isNativeBackdropActive()) teardown();
      });
      observer =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
      observer?.observe(el);
      window.addEventListener("resize", sync);
    })();
    return () => {
      alive = false;
      unsubscribe?.();
      teardown();
    };
  }, [wantNative, enabled, available, interactive, platform, ref, regionId]);

  return nativeLive && backdropActive ? "native" : cssGlassTier();
}

export function GlassSurface({
  variant,
  interactive = false,
  className,
  children,
  ...rest
}: GlassSurfaceProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const tier = useNativeGlassAnchor(ref, { interactive });
  return (
    <div
      {...rest}
      ref={ref}
      data-glass-tier={tier}
      className={
        className
          ? `eliza-glass-${variant} ${className}`
          : `eliza-glass-${variant}`
      }
    >
      {children}
    </div>
  );
}
