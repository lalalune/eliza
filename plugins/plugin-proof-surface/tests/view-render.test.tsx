/**
 * Exercises the actual React view export through server rendering.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PluginView, {
  VIEW_ID,
  VIEW_INTENT,
  VIEW_SCAFFOLD_MARKER,
} from "../src/views/PluginView.js";

describe("standalone GUI view", () => {
  it("renders the registered identity, creation intent, and proof marker", () => {
    const html = renderToStaticMarkup(<PluginView />);

    expect(VIEW_ID).toBe("proof-surface");
    expect(VIEW_INTENT).toBe("proof-surface-jiykxa VIEW_CREATED_JIYKXA Proof Surface jiykxa");
    expect(html).toContain(`data-eliza-view-id="${VIEW_ID}"`);
    expect(html).toContain(VIEW_SCAFFOLD_MARKER);
    expect(html).toContain("View scaffold ready");
  });
});
