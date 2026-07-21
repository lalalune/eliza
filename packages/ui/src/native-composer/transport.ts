/**
 * Realm-local transport for native-composer frames. Platform hosts enqueue
 * native operations here before React mounts; AppProvider drains them and emits
 * renderer events on the reverse channel for the iOS, Android, or desktop shim.
 */

import type { ComposerEvent } from "./contract";

export const NATIVE_COMPOSER_OPERATION_EVENT =
  "eliza:native-composer:operation" as const;
export const NATIVE_COMPOSER_RENDERER_EVENT =
  "eliza:native-composer:renderer-event" as const;

declare global {
  interface Window {
    __ELIZA_NATIVE_COMPOSER_QUEUE__?: unknown[];
  }
}

/** Queue and dispatch one untrusted native frame without requiring React. */
export function dispatchNativeComposerOperation(raw: unknown): void {
  if (typeof window === "undefined") return;
  window.__ELIZA_NATIVE_COMPOSER_QUEUE__ ??= [];
  const queue = window.__ELIZA_NATIVE_COMPOSER_QUEUE__;
  queue.push(raw);
  window.dispatchEvent(
    new CustomEvent(NATIVE_COMPOSER_OPERATION_EVENT, { detail: raw }),
  );
}

/** Drain cold-start operations after the composer runtime has subscribed. */
export function drainNativeComposerOperations(): unknown[] {
  if (typeof window === "undefined") return [];
  return window.__ELIZA_NATIVE_COMPOSER_QUEUE__?.splice(0) ?? [];
}

/** Remove the exact live-delivered frame without discarding later frames. */
export function acknowledgeNativeComposerOperation(raw: unknown): void {
  if (typeof window === "undefined") return;
  const queue = window.__ELIZA_NATIVE_COMPOSER_QUEUE__;
  const index = queue?.indexOf(raw) ?? -1;
  if (index >= 0) queue?.splice(index, 1);
}

/** Publish a validated renderer event for the platform adapter to consume. */
export function dispatchNativeComposerRendererEvent(
  event: ComposerEvent,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(NATIVE_COMPOSER_RENDERER_EVENT, { detail: event }),
  );
}
