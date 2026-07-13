/**
 * Runtime entrypoint for a standalone plugin-contributed GUI view.
 *
 * The local view shape keeps this scaffold compatible with installed core
 * packages that predate Plugin.views while preserving the current runtime
 * manifest exactly.
 */

import type { Plugin } from "@elizaos/core";
import { infoProvider } from "./providers/info.js";

interface StandaloneGuiView {
  id: string;
  label: string;
  description: string;
  icon: string;
  path: string;
  modalities: ["gui"];
  viewKind: "release";
  bundlePath: string;
  componentExport: string;
  heroImagePath: string;
  visibleInManager: boolean;
  desktopTabEnabled: boolean;
}

interface ViewEnabledPlugin extends Plugin {
  views: StandaloneGuiView[];
}

const plugin: ViewEnabledPlugin = {
  name: "proof-surface",
  description: "Proof Surface GUI view for: proof-surface-jiykxa VIEW_CREATED_JIYKXA Proof Surface jiykxa",
  providers: [infoProvider],
  views: [
    {
      id: "proof-surface",
      label: "Proof Surface",
      description: "proof-surface-jiykxa VIEW_CREATED_JIYKXA Proof Surface jiykxa",
      icon: "PanelTopOpen",
      path: "/proof-surface",
      modalities: ["gui"],
      viewKind: "release",
      bundlePath: "dist/views/bundle.js",
      componentExport: "PluginView",
      heroImagePath: "assets/hero.svg",
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default plugin;
export { infoProvider, plugin };
