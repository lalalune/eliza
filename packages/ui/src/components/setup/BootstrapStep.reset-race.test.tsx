// @vitest-environment jsdom

/**
 * A delayed component exchange cannot restore a bootstrap session after reset
 * invalidates its generation.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type { BootstrapExchangeResult } from "../../api/client-agent";
import {
  BOOTSTRAP_SESSION_STORAGE_KEY,
  beginRendererCredentialReset,
  finishRendererCredentialReset,
} from "../../state/credential-storage-keys";
import { BootstrapStep } from "./BootstrapStep";

describe("BootstrapStep destructive reset fence", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
    client.setToken(null);
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    client.setToken(null);
    vi.restoreAllMocks();
  });

  it("drops a successful exchange that resolves after reset begins", async () => {
    let resolveExchange:
      | ((result: BootstrapExchangeResult) => void)
      | undefined;
    const exchangeFn = vi.fn(
      () =>
        new Promise<BootstrapExchangeResult>((resolve) => {
          resolveExchange = resolve;
        }),
    );
    const onAdvance = vi.fn();

    render(<BootstrapStep exchangeFn={exchangeFn} onAdvance={onAdvance} />);
    fireEvent.change(screen.getByLabelText("Bootstrap token"), {
      target: { value: "bootstrap-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(resolveExchange).toBeTypeOf("function"));

    const resetGeneration = beginRendererCredentialReset();
    try {
      await act(async () => {
        resolveExchange?.({
          ok: true,
          sessionId: "late-session",
          identityId: "identity-id",
          expiresAt: Date.now() + 60_000,
        });
        await Promise.resolve();
      });

      expect(onAdvance).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(BOOTSTRAP_SESSION_STORAGE_KEY)).toBeNull();
      expect(client.apiToken).toBeNull();
    } finally {
      finishRendererCredentialReset(resetGeneration);
    }
  });
});
