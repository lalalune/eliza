/**
 * Verifies that reset drains an active credential write and rejects new writes
 * until cleanup has removed everything the drained operation persisted.
 */

import { describe, expect, it, vi } from "vitest";

import {
  withCredentialStateMutation,
  withCredentialStateReset,
} from "./credential-state-lock";

describe("credential state lock", () => {
  it("lets accepted credential mutations overlap", async () => {
    let active = 0;
    let peak = 0;
    let enteredCount = 0;
    let markBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      markBothEntered = resolve;
    });
    let releaseBoth!: () => void;
    const pause = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const mutation = () =>
      withCredentialStateMutation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        enteredCount += 1;
        if (enteredCount === 2) markBothEntered();
        await pause;
        active -= 1;
      });

    const first = mutation();
    const second = mutation();
    await bothEntered;

    expect(peak).toBe(2);
    releaseBoth();
    await Promise.all([first, second]);
  });

  it("drains an active mutation before reset and prevents post-reset resurrection", async () => {
    const persisted = new Map<string, string>();
    let releaseMutation!: () => void;
    const mutationPaused = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let mutationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      mutationEntered = resolve;
    });

    const bootMutation = withCredentialStateMutation(async () => {
      mutationEntered();
      await mutationPaused;
      persisted.set("EVM_PRIVATE_KEY", "boot-secret");
    });
    await entered;

    const resetWork = vi.fn(async () => {
      persisted.clear();
    });
    const reset = withCredentialStateReset(resetWork);

    await expect(
      withCredentialStateMutation(async () => {
        persisted.set("SOLANA_PRIVATE_KEY", "late-secret");
      }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_RESET_IN_PROGRESS" });
    expect(resetWork).not.toHaveBeenCalled();

    releaseMutation();
    await bootMutation;
    await reset;

    expect(resetWork).toHaveBeenCalledOnce();
    expect(persisted.size).toBe(0);
  });

  it("releases the gate after reset fails", async () => {
    await expect(
      withCredentialStateReset(async () => {
        throw new Error("reset failed");
      }),
    ).rejects.toThrow("reset failed");

    await expect(
      withCredentialStateMutation(async () => "ready"),
    ).resolves.toBe("ready");
  });

  it("allows helpers in one accepted request to share the same lock", async () => {
    await expect(
      withCredentialStateMutation(() =>
        withCredentialStateMutation(async () => "nested"),
      ),
    ).resolves.toBe("nested");
  });

  it("does not let detached work reuse an expired mutation context", async () => {
    let releaseDetached!: () => void;
    const detachedPause = new Promise<void>((resolve) => {
      releaseDetached = resolve;
    });
    let detached!: Promise<string>;
    await withCredentialStateMutation(async () => {
      detached = (async () => {
        await detachedPause;
        return withCredentialStateMutation(async () => "late-write");
      })();
    });

    let releaseReset!: () => void;
    const resetPause = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const reset = withCredentialStateReset(() => resetPause);
    releaseDetached();
    await expect(detached).rejects.toMatchObject({
      code: "CREDENTIAL_RESET_IN_PROGRESS",
    });
    releaseReset();
    await reset;
  });
});
