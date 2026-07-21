/**
 * Connects the renderer's native-composer DOM transport to the concrete
 * Capacitor and Electrobun hosts. Cold-start operations are drained before live
 * listeners attach; validated renderer events are published back to the host.
 */

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "@elizaos/ui/bridge";
import {
  dispatchNativeComposerOperation,
  NATIVE_COMPOSER_RENDERER_EVENT,
  NATIVE_COMPOSER_SCHEMA,
} from "@elizaos/ui/native-composer";

interface NativeComposerPlugin {
  drainOperations(): Promise<{ schema: string; operations: unknown[] }>;
  publishEvent(options: { schema: string; event: unknown }): Promise<void>;
  addListener(
    eventName: "operationStream",
    listener: (payload: unknown) => void,
  ): Promise<PluginListenerHandle>;
}

let cleanupInstalledBridge: (() => void) | null = null;

function forwardOperationStream(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const envelope = payload as { schema?: unknown; operations?: unknown };
  if (envelope.schema !== NATIVE_COMPOSER_SCHEMA) return;
  if (!Array.isArray(envelope.operations)) return;
  for (const operation of envelope.operations) {
    dispatchNativeComposerOperation(operation);
  }
}

/** Install the active platform adapter once for the renderer lifetime. */
export async function installNativeComposerPlatformBridge(): Promise<void> {
  if (cleanupInstalledBridge) return;
  const removers: Array<() => void> = [];
  let publishEvent: ((event: unknown) => Promise<void>) | null = null;

  if (Capacitor.isNativePlatform()) {
    const plugin =
      Capacitor.registerPlugin<NativeComposerPlugin>("NativeComposer");
    const listener = await plugin.addListener(
      "operationStream",
      forwardOperationStream,
    );
    removers.push(() => void listener.remove());
    const drained = await plugin.drainOperations();
    forwardOperationStream(drained);
    publishEvent = async (event) => {
      await plugin.publishEvent({ schema: NATIVE_COMPOSER_SCHEMA, event });
    };
  } else if (isElectrobunRuntime()) {
    removers.push(
      subscribeDesktopBridgeEvent({
        rpcMessage: "nativeComposerOperationStream",
        ipcChannel: "native-composer:operationStream",
        listener: forwardOperationStream,
      }),
    );
    const drained = await invokeDesktopBridgeRequest<unknown>({
      rpcMethod: "nativeComposerDrainOperations",
      ipcChannel: "native-composer:drainOperations",
    });
    forwardOperationStream(drained);
    publishEvent = async (event) => {
      await invokeDesktopBridgeRequest({
        rpcMethod: "nativeComposerPublishEvent",
        ipcChannel: "native-composer:publishEvent",
        params: { schema: NATIVE_COMPOSER_SCHEMA, event },
      });
    };
  }

  const onRendererEvent = (event: Event): void => {
    if (!publishEvent) return;
    void publishEvent((event as CustomEvent<unknown>).detail).catch((error) => {
      // error-policy:J5 this auxiliary mirror rejection is observed here; the
      // renderer-owned composer remains the authoritative user-visible state.
      console.error("[NativeComposer] Could not publish renderer event", error);
    });
  };
  window.addEventListener(NATIVE_COMPOSER_RENDERER_EVENT, onRendererEvent);
  removers.push(() =>
    window.removeEventListener(NATIVE_COMPOSER_RENDERER_EVENT, onRendererEvent),
  );
  cleanupInstalledBridge = () => {
    for (const remove of removers) remove();
    cleanupInstalledBridge = null;
  };
}

export function resetNativeComposerPlatformBridgeForTests(): void {
  cleanupInstalledBridge?.();
}
