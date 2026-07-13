/**
 * Produces one browser-loadable ES module for the plugin view registry.
 */

import path from "node:path";
import { defineConfig } from "vite";

const hostExternals = new Set([
  "react",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
]);

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: "dist/views",
    sourcemap: true,
    lib: {
      entry: path.resolve(process.cwd(), "src/views/view-bundle.ts"),
      formats: ["es"],
      fileName: () => "bundle.js",
    },
    rollupOptions: {
      external: (id) =>
        hostExternals.has(id) ||
        [...hostExternals].some((external) => id.startsWith(`${external}/`)),
      output: {
        exports: "named",
        codeSplitting: false,
      },
    },
  },
  define: {
    "import.meta.env.DEV": JSON.stringify(false),
    "import.meta.env.PROD": JSON.stringify(true),
    "import.meta.env.MODE": JSON.stringify("production"),
    "import.meta.env.SSR": JSON.stringify(false),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});
