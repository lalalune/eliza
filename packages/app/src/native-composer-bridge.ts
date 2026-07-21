/**
 * Connects the renderer's native-composer DOM transport to the concrete
 * Capacitor and Electrobun hosts. Cold-start operations are drained before live
 * listeners attach; validated renderer events are published back to the host.
 */

import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
  subscribeDesktopBridgeEvent,
} from "@elizaos/ui/bridge";
import {
  dispatchNativeComposerOperation,
  NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
  NATIVE_COMPOSER_RENDERER_EVENT,
  NATIVE_COMPOSER_SCHEMA,
  type NativeComposerOperationAcknowledgment,
} from "@elizaos/ui/native-composer";

interface NativeComposerPlugin {
  drainOperations(): Promise<{ schema: string; operations: unknown[] }>;
  acknowledgeOperation(options: {
    schema: string;
    acknowledgment: NativeComposerOperationAcknowledgment;
  }): Promise<{ removed: boolean }>;
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
  for (const delivered of envelope.operations) {
    if (
      delivered &&
      typeof delivered === "object" &&
      "deliveryId" in delivered &&
      typeof delivered.deliveryId === "string"
    ) {
      dispatchNativeComposerOperation(
        "operation" in delivered ? delivered.operation : undefined,
        delivered.deliveryId,
      );
    } else {
      // Legacy hosts emitted the raw operation. It remains usable, but only a
      // delivery-id host can retain it until the renderer acknowledges it.
      dispatchNativeComposerOperation(delivered);
    }
  }
}

/** Install the active platform adapter once for the renderer lifetime. */
export async function installNativeComposerPlatformBridge(): Promise<void> {
  if (cleanupInstalledBridge) return;
  const removers: Array<() => void> = [];
  let publishEvent: ((event: unknown) => Promise<void>) | null = null;
  let acknowledgeOperation:
    | ((acknowledgment: NativeComposerOperationAcknowledgment) => Promise<void>)
    | null = null;
  const onRendererEvent = (event: Event): void => {
    if (!publishEvent) return;
    void publishEvent((event as CustomEvent<unknown>).detail).catch((error) => {
      // error-policy:J5 this auxiliary mirror rejection is observed here; the
      // renderer-owned composer remains the authoritative user-visible state.
      logger.error(
        { error },
        "[NativeComposer] Could not publish renderer event",
      );
    });
  };
  const onAcknowledgment = (event: Event): void => {
    if (!acknowledgeOperation) return;
    const acknowledgment = (
      event as CustomEvent<NativeComposerOperationAcknowledgment>
    ).detail;
    void acknowledgeOperation(acknowledgment).catch((error) => {
      // error-policy:J5 The native queue remains intact when this auxiliary
      // acknowledgment fails, and the next cold-start drain redelivers it.
      logger.error(
        { acknowledgment, error },
        "[NativeComposer] Could not acknowledge native operation",
      );
    });
  };
  // Reverse listeners must exist before drain forwarding: a mounted renderer
  // can reduce a cold-start frame synchronously and acknowledge it in that call.
  window.addEventListener(NATIVE_COMPOSER_RENDERER_EVENT, onRendererEvent);
  window.addEventListener(
    NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
    onAcknowledgment,
  );
  removers.push(
    () =>
      window.removeEventListener(
        NATIVE_COMPOSER_RENDERER_EVENT,
        onRendererEvent,
      ),
    () =>
      window.removeEventListener(
        NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
        onAcknowledgment,
      ),
  );

  if (Capacitor.isNativePlatform()) {
    const plugin =
      Capacitor.registerPlugin<NativeComposerPlugin>("NativeComposer");
    publishEvent = async (event) => {
      await plugin.publishEvent({ schema: NATIVE_COMPOSER_SCHEMA, event });
    };
    acknowledgeOperation = async (acknowledgment) => {
      await plugin.acknowledgeOperation({
        schema: NATIVE_COMPOSER_SCHEMA,
        acknowledgment,
      });
    };
    const listener = await plugin.addListener(
      "operationStream",
      forwardOperationStream,
    );
    removers.push(() => void listener.remove());
    const drained = await plugin.drainOperations();
    forwardOperationStream(drained);
  } else if (isElectrobunRuntime()) {
    publishEvent = async (event) => {
      await invokeDesktopBridgeRequest({
        rpcMethod: "nativeComposerPublishEvent",
        ipcChannel: "native-composer:publishEvent",
        params: { schema: NATIVE_COMPOSER_SCHEMA, event },
      });
    };
    acknowledgeOperation = async (acknowledgment) => {
      await invokeDesktopBridgeRequest({
        rpcMethod: "nativeComposerAcknowledgeOperation",
        ipcChannel: "native-composer:acknowledgeOperation",
        params: { schema: NATIVE_COMPOSER_SCHEMA, acknowledgment },
      });
    };
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
  }
  cleanupInstalledBridge = () => {
    for (const remove of removers) remove();
    cleanupInstalledBridge = null;
  };
}

export function resetNativeComposerPlatformBridgeForTests(): void {
  cleanupInstalledBridge?.();
}
