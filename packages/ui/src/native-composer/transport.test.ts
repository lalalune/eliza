// @vitest-environment jsdom

/** Covers the cold-start queue and bidirectional DOM transport in jsdom. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeNativeComposerOperation,
  dispatchNativeComposerOperation,
  dispatchNativeComposerRendererEvent,
  drainNativeComposerOperations,
  NATIVE_COMPOSER_OPERATION_EVENT,
  NATIVE_COMPOSER_RENDERER_EVENT,
} from "./transport";

describe("native composer realm transport", () => {
  beforeEach(() => {
    window.__ELIZA_NATIVE_COMPOSER_QUEUE__ = [];
  });

  it("queues cold-start frames and also dispatches them live", () => {
    const listener = vi.fn();
    window.addEventListener(NATIVE_COMPOSER_OPERATION_EVENT, listener);
    const operation = { type: "text.set", opId: "ios-1", text: "hello" };

    dispatchNativeComposerOperation(operation);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(drainNativeComposerOperations()).toEqual([operation]);
    expect(drainNativeComposerOperations()).toEqual([]);
    window.removeEventListener(NATIVE_COMPOSER_OPERATION_EVENT, listener);
  });

  it("acknowledges only the delivered live frame", () => {
    const first = { type: "text.set", opId: "one", text: "one" };
    const second = { type: "text.set", opId: "two", text: "two" };
    dispatchNativeComposerOperation(first);
    dispatchNativeComposerOperation(second);

    acknowledgeNativeComposerOperation(first);

    expect(drainNativeComposerOperations()).toEqual([second]);
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
