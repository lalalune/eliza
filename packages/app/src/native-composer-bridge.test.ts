/**
 * Verifies the platform adapter's cold-start ordering with a concrete native
 * delivery envelope: reverse event and acknowledgment listeners must be live
 * before the retained host queue is forwarded into the mounted renderer.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  addListener: vi.fn(),
  drainOperations: vi.fn(),
  acknowledgeOperation: vi.fn(),
  publishEvent: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    registerPlugin: () => plugin,
  },
}));
vi.mock("@elizaos/logger", () => ({
  logger: { error: vi.fn() },
}));
vi.mock("@elizaos/ui/bridge", () => ({
  invokeDesktopBridgeRequest: vi.fn(),
  isElectrobunRuntime: () => false,
  subscribeDesktopBridgeEvent: vi.fn(),
}));

import {
  acknowledgeNativeComposerOperation,
  dispatchNativeComposerRendererEvent,
  NATIVE_COMPOSER_OPERATION_EVENT,
  NATIVE_COMPOSER_SCHEMA,
  type NativeComposerOperationDelivery,
} from "@elizaos/ui/native-composer";
import {
  installNativeComposerPlatformBridge,
  resetNativeComposerPlatformBridgeForTests,
} from "./native-composer-bridge";

beforeEach(() => {
  vi.clearAllMocks();
  window.__ELIZA_NATIVE_COMPOSER_QUEUE__ = [];
  plugin.addListener.mockResolvedValue({ remove: vi.fn() });
  plugin.drainOperations.mockResolvedValue({
    schema: NATIVE_COMPOSER_SCHEMA,
    operations: [
      {
        deliveryId: "cold-delivery",
        operation: { type: "text.set", opId: "cold-op", text: "hello" },
      },
    ],
  });
  plugin.acknowledgeOperation.mockResolvedValue({ removed: true });
  plugin.publishEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  resetNativeComposerPlatformBridgeForTests();
});

describe("installNativeComposerPlatformBridge", () => {
  it("publishes and acknowledges synchronous cold-drain results", async () => {
    const consume = (event: Event): void => {
      const delivery = (event as CustomEvent<NativeComposerOperationDelivery>)
        .detail;
      dispatchNativeComposerRendererEvent({
        type: "draft.changed",
        draft: {
          text: "hello",
          attachments: [],
          reply: null,
          mentions: [],
          focused: false,
          keyboard: "hidden",
          revision: 1,
        },
      });
      acknowledgeNativeComposerOperation(delivery, {
        disposition: "persisted",
        resultStatus: "applied",
      });
    };
    window.addEventListener(NATIVE_COMPOSER_OPERATION_EVENT, consume);

    await installNativeComposerPlatformBridge();

    expect(plugin.publishEvent).toHaveBeenCalledWith({
      schema: NATIVE_COMPOSER_SCHEMA,
      event: expect.objectContaining({ type: "draft.changed" }),
    });
    expect(plugin.acknowledgeOperation).toHaveBeenCalledWith({
      schema: NATIVE_COMPOSER_SCHEMA,
      acknowledgment: {
        deliveryId: "cold-delivery",
        disposition: "persisted",
        resultStatus: "applied",
      },
    });
    window.removeEventListener(NATIVE_COMPOSER_OPERATION_EVENT, consume);
  });
});
