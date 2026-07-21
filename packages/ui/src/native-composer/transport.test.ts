// @vitest-environment jsdom

/** Covers the cold-start queue and bidirectional DOM transport in jsdom. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeNativeComposerOperation,
  dispatchNativeComposerOperation,
  dispatchNativeComposerRendererEvent,
  drainNativeComposerOperations,
  NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT,
  NATIVE_COMPOSER_OPERATION_EVENT,
  NATIVE_COMPOSER_RENDERER_EVENT,
} from "./transport";

describe("native composer realm transport", () => {
  beforeEach(() => {
    window.__ELIZA_NATIVE_COMPOSER_QUEUE__ = [];
  });

  it("retains cold-start frames until the renderer acknowledges persistence", () => {
    const listener = vi.fn();
    window.addEventListener(NATIVE_COMPOSER_OPERATION_EVENT, listener);
    const operation = { type: "text.set", opId: "ios-1", text: "hello" };

    dispatchNativeComposerOperation(operation, "delivery-1");

    expect(listener).toHaveBeenCalledTimes(1);
    const deliveries = drainNativeComposerOperations();
    expect(deliveries).toEqual([{ deliveryId: "delivery-1", operation }]);
    expect(drainNativeComposerOperations()).toEqual(deliveries);
    acknowledgeNativeComposerOperation(deliveries[0], {
      disposition: "persisted",
      resultStatus: "applied",
    });
    expect(drainNativeComposerOperations()).toEqual([]);
    window.removeEventListener(NATIVE_COMPOSER_OPERATION_EVENT, listener);
  });

  it("acknowledges only the delivered live frame", () => {
    const first = { type: "text.set", opId: "one", text: "one" };
    const second = { type: "text.set", opId: "two", text: "two" };
    dispatchNativeComposerOperation(first);
    dispatchNativeComposerOperation(second);

    const [firstDelivery, secondDelivery] = drainNativeComposerOperations();
    acknowledgeNativeComposerOperation(firstDelivery, {
      disposition: "rejected",
      resultStatus: "invalid-input",
      reason: "invalid-input",
    });

    expect(drainNativeComposerOperations()).toEqual([secondDelivery]);
  });

  it("publishes a typed host acknowledgment for a durable delivery", () => {
    const listener = vi.fn();
    window.addEventListener(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, listener);
    dispatchNativeComposerOperation(
      { type: "text.set", opId: "one", text: "one" },
      "host-delivery-1",
    );
    const [delivery] = drainNativeComposerOperations();

    acknowledgeNativeComposerOperation(delivery, {
      disposition: "persisted",
      resultStatus: "applied",
    });

    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        deliveryId: "host-delivery-1",
        disposition: "persisted",
        resultStatus: "applied",
      },
    });
    window.removeEventListener(NATIVE_COMPOSER_ACKNOWLEDGMENT_EVENT, listener);
  });

  it("publishes typed renderer events on the reverse channel", () => {
    const listener = vi.fn();
    window.addEventListener(NATIVE_COMPOSER_RENDERER_EVENT, listener);
    dispatchNativeComposerRendererEvent({
      type: "focus.changed",
      focused: true,
      keyboard: "shown",
    });

    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: { type: "focus.changed", focused: true, keyboard: "shown" },
    });
    window.removeEventListener(NATIVE_COMPOSER_RENDERER_EVENT, listener);
  });
});
