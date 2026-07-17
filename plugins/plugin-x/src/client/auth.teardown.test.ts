/** Authentication teardown waits for token acquisition and prevents a late client from becoming active. */
import { describe, expect, it, vi } from "vitest";
import { TwitterAuth } from "./auth";
import type { TwitterAuthProvider } from "./auth-providers/types";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("TwitterAuth teardown", () => {
  it("drains delayed token acquisition and rejects its post-logout continuation", async () => {
    const token = deferred<string>();
    const tokenStarted = deferred<void>();
    const provider: TwitterAuthProvider = {
      mode: "oauth",
      getAccessToken: vi.fn(async () => {
        tokenStarted.resolve();
        return await token.promise;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const auth = new TwitterAuth(provider);

    const client = auth.getV2Client();
    await tokenStarted.promise;
    let logoutSettled = false;
    const logout = auth.logout().then(() => {
      logoutSettled = true;
    });
    await Promise.resolve();
    expect(logoutSettled).toBe(false);

    token.resolve("late-access-token");
    await expect(client).rejects.toMatchObject({ name: "AbortError" });
    await logout;

    expect(auth.hasToken()).toBe(false);
    await expect(auth.getV2Client()).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
