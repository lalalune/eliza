/**
 * Guards the canonical iOS shell registration that makes the app-local native
 * composer plugin callable from the Capacitor WebView after App Intent launch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bridgeViewControllerSource = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "app-core",
    "platforms",
    "ios",
    "App",
    "App",
    "ElizaBridgeViewController.swift",
  ),
  "utf8",
);

describe("iOS native composer registration", () => {
  it("registers the app-local plugin when the Capacitor bridge loads", () => {
    const didLoad = bridgeViewControllerSource.slice(
      bridgeViewControllerSource.indexOf("override func capacitorDidLoad()"),
    );

    expect(didLoad).toContain(
      "bridge?.registerPluginInstance(NativeComposerPlugin())",
    );
  });
});
