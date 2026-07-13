/**
 * Browser component for the plugin's GUI view.
 *
 * The visible intent and stable marker give the coding agent and the live E2E
 * verifier an unambiguous baseline to customize and prove after hot-loading.
 */

import type { CSSProperties } from "react";

export const VIEW_ID = "proof-surface";
export const VIEW_LABEL = "Proof Surface";
export const VIEW_INTENT = "proof-surface-jiykxa VIEW_CREATED_JIYKXA Proof Surface jiykxa";
export const VIEW_SCAFFOLD_MARKER = "eliza-view-scaffold:proof-surface";

const styles: Record<string, CSSProperties> = {
  shell: {
    alignItems: "center",
    background: "#111111",
    color: "#f5f5f4",
    display: "flex",
    justifyContent: "center",
    minHeight: "100%",
    padding: "clamp(24px, 6vw, 72px)",
  },
  panel: {
    background: "#1c1917",
    border: "1px solid #44403c",
    borderRadius: 20,
    boxShadow: "0 24px 70px rgba(0, 0, 0, 0.36)",
    maxWidth: 760,
    padding: "clamp(28px, 5vw, 56px)",
    width: "100%",
  },
  eyebrow: {
    color: "#fb923c",
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.12em",
    margin: "0 0 14px",
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(36px, 7vw, 68px)",
    letterSpacing: "-0.04em",
    lineHeight: 0.96,
    margin: 0,
  },
  intent: {
    color: "#d6d3d1",
    fontSize: 18,
    lineHeight: 1.65,
    margin: "28px 0 0",
  },
  status: {
    borderLeft: "3px solid #f97316",
    color: "#a8a29e",
    fontSize: 14,
    lineHeight: 1.5,
    marginTop: 36,
    paddingLeft: 16,
  },
};

export function PluginView() {
  return (
    <main
      aria-labelledby="proof-surface-title"
      data-eliza-view-id={VIEW_ID}
      data-eliza-view-marker={VIEW_SCAFFOLD_MARKER}
      style={styles.shell}
    >
      <section style={styles.panel}>
        <p style={styles.eyebrow}>View scaffold ready</p>
        <h1 id="proof-surface-title" style={styles.title}>
          {VIEW_LABEL}
        </h1>
        <p style={styles.intent}>{VIEW_INTENT}</p>
        <p role="status" style={styles.status}>
          The Plugin.views manifest, React export, render test, and browser
          bundle are connected. Build the requested experience from this
          working surface.
        </p>
      </section>
    </main>
  );
}

export default PluginView;
