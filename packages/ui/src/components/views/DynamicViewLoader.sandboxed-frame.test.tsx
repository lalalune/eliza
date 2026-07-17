// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetDynamicViewLoaderCacheForTests,
  DynamicViewLoader,
} from "./DynamicViewLoader";

describe("DynamicViewLoader sandboxed iframe document contract", () => {
  afterEach(() => {
    delete window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__;
    cleanup();
    __resetDynamicViewLoaderCacheForTests();
    vi.restoreAllMocks();
  });

  it("renders sandboxed-iframe views from frameUrl, never from the JavaScript bundleUrl", () => {
    const importBundle = vi.fn();
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/sandboxed.view/bundle.js"
        frameUrl="/api/views/sandboxed.view/frame.html"
        viewId="sandboxed.view"
        surface={{
          isolation: "sandboxed-iframe",
          capabilities: ["navigate", "storage"],
        }}
      />,
    );

    const frame = screen.getByTestId(
      "sandboxed-view-frame-sandboxed.view",
    ) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(
      "/api/views/sandboxed.view/frame.html",
    );
    expect(frame.getAttribute("src")).not.toBe(
      "/api/views/sandboxed.view/bundle.js",
    );
    expect(frame.getAttribute("sandbox")?.split(" ")).toContain(
      "allow-scripts",
    );
    const loadedView = screen.getByTestId("dynamic-view-loader");
    expect(loadedView.getAttribute("data-view-id")).toBe("sandboxed.view");
    expect(loadedView.getAttribute("data-view-loader-state")).toBe("loading");
    expect(loadedView.hasAttribute("data-view-state")).toBe(false);

    fireEvent.load(frame);

    expect(loadedView.getAttribute("data-view-loader-state")).toBe("loaded");
    expect(importBundle).not.toHaveBeenCalled();
  });

  it("reports a frame load failure as error and retries from loading", async () => {
    render(
      <DynamicViewLoader
        frameUrl="/api/views/failing.frame/frame.html"
        viewId="failing.frame"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    const frame = screen.getByTestId("sandboxed-view-frame-failing.frame");
    const loader = screen.getByTestId("dynamic-view-loader");
    expect(loader.getAttribute("data-view-loader-state")).toBe("loading");

    fireEvent.error(frame);

    await waitFor(() =>
      expect(
        screen
          .getByTestId("dynamic-view-loader")
          .getAttribute("data-view-loader-state"),
      ).toBe("error"),
    );
    expect(screen.getByText("Failed to load view")).toBeTruthy();
    expect(
      screen.queryByTestId("sandboxed-view-frame-failing.frame"),
    ).toBeNull();
    expect(
      document.querySelector('[data-view-loader-state="loaded"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() =>
      expect(
        screen
          .getByTestId("dynamic-view-loader")
          .getAttribute("data-view-loader-state"),
      ).toBe("loading"),
    );
    expect(
      screen.getByTestId("sandboxed-view-frame-failing.frame"),
    ).toBeTruthy();
  });

  it("fails closed when a sandboxed-iframe view only has a JavaScript bundleUrl", () => {
    const importBundle = vi.fn();
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__ = importBundle;

    render(
      <DynamicViewLoader
        bundleUrl="/api/views/broken.sandbox/bundle.js"
        viewId="broken.sandbox"
        surface={{ isolation: "sandboxed-iframe" }}
      />,
    );

    expect(screen.getByText("Failed to load view")).toBeTruthy();
    expect(screen.getByText(/require a frameUrl HTML document/)).toBeTruthy();
    expect(
      screen.queryByTestId("sandboxed-view-frame-broken.sandbox"),
    ).toBeNull();
    expect(screen.queryByTestId("dynamic-view-loader")).toBeNull();
    expect(importBundle).not.toHaveBeenCalled();
  });
});
