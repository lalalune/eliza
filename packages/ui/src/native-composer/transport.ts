/**
 * Realm-local transport for native-composer frames. Platform hosts enqueue
 * native operations here before React mounts; AppProvider drains them and emits
 * renderer events on the reverse channel for the iOS, Android, or desktop shim.
 */

import type { ComposerEvent, DispatchResult } from "./contract";

export const NATIVE_COMPOSER_OPERATION_EVENT =
  "eliza:native-composer:operation" as const;
export const NATIVE_COMPOSER_RENDERER_EVENT =
  "eliza:native-composer:renderer-event" as const;
export const NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT =
  "eliza:native-composer:acknowledgment" as const;

/** One host delivery retained until the renderer durably accepts or rejects it. */
export interface NativeComposerOperationDelivery {
  deliveryId?: string;
  operation: unknown;
}

export interface NativeComposerOperationAcknowledgment {
  deliveryId: string;
  disposition: "persisted" | "rejected";
  resultStatus: DispatchResult["status"] | "invalid-input";
  reason?: string;
}

declare global {
  interface Window {
    __ELIZA_NATIVE_COMPOSER_QUEUE__?: NativeComposerOperationDelivery[];
  }
}

/** Queue and dispatch one untrusted native frame without requiring React. */
export function dispatchNativeComposerOperation(
  raw: unknown,
  deliveryId?: string,
): void {
  if (typeof window === "undefined") return;
  window.__ELIZA_NATIVE_COMPOSER_QUEUE__ ??= [];
  const queue = window.__ELIZA_NATIVE_COMPOSER_QUEUE__;
  const delivery: NativeComposerOperationDelivery = {
    operation: raw,
    ...(deliveryId ? { deliveryId } : {}),
  };
  queue.push(delivery);
  window.dispatchEvent(
    new CustomEvent(NATIVE_COMPOSER_OPERATION_EVENT, { detail: delivery }),
  );
}

/** Peek cold-start operations; acknowledgments remove them after persistence. */
export function drainNativeComposerOperations(): NativeComposerOperationDelivery[] {
  if (typeof window === "undefined") return [];
  return [...(window.__ELIZA_NATIVE_COMPOSER_QUEUE__ ?? [])];
}

/** Remove one delivery and tell the native host why it is safe to discard. */
export function acknowledgeNativeComposerOperation(
  delivery: NativeComposerOperationDelivery,
  result: Omit<NativeComposerOperationAcknowledgment, "deliveryId">,
): void {
  if (typeof window === "undefined") return;
  const queue = window.__ELIZA_NATIVE_COMPOSER_QUEUE__;
  const index = queue?.indexOf(delivery) ?? -1;
  if (index >= 0) queue?.splice(index, 1);
  if (!delivery.deliveryId) return;
  const acknowledgment: NativeComposerOperationAcknowledgment = {
    deliveryId: delivery.deliveryId,
    ...result,
  };
  window.dispatchEvent(
    new CustomEvent(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, {
      detail: acknowledgment,
    }),
  );
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
