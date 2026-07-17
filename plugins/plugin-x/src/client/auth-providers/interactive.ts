/**
 * Interactive helpers for the OAuth 2.0 PKCE first-time authorization: a loopback
 * HTTP server that captures the `?code`/`?state` redirect (validating state, timing
 * out, failing fast on bind errors) and a TTY prompt that reads the pasted redirected
 * URL when a loopback callback isn't usable. Both feed the code back to
 * `OAuth2PKCEAuthProvider.interactiveLogin`.
 */
import { createServer } from "node:http";
import * as readline from "node:readline";
import { URL } from "node:url";
import { logger } from "@elizaos/core";

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Twitter OAuth authorization was stopped");
  error.name = "AbortError";
  return error;
}

function canPrompt(): boolean {
  return !!process.stdin && !!process.stdout && process.stdin.isTTY === true;
}

export async function promptForRedirectedUrl(
  promptText: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw abortError(signal);
  if (!canPrompt()) {
    throw new Error(
      "Twitter OAuth requires interactive setup, but stdin is not a TTY. " +
        "Re-run with an interactive terminal or use a runtime with persistent settings storage.",
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const onAbort = () => {
        finish(abortError(signal as AbortSignal));
        rl.close();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      rl.question(promptText, (value) => finish(undefined, value));
    });
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function waitForLoopbackCallback(
  redirectUri: string,
  expectedState: string,
  timeoutMs = 5 * 60 * 1000,
  signal?: AbortSignal,
): Promise<OAuthCallbackResult> {
  if (signal?.aborted) throw abortError(signal);
  const url = new URL(redirectUri);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(
      `Redirect URI must be loopback (127.0.0.1/localhost) to use local callback server; got ${url.hostname}`,
    );
  }

  // Avoid privileged ports by default. If the user doesn't specify a port, use 8080.
  const port = Number(url.port || "8080");
  const path = url.pathname || "/";

  return await new Promise<OAuthCallbackResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (err?: Error, value?: OAuthCallbackResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else if (value) resolve(value);
      else reject(new Error("OAuth callback finished without result"));
      if (server.listening) {
        server.close();
      }
    };

    const onAbort = () => finish(abortError(signal as AbortSignal));

    const server = createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "", `http://${url.hostname}:${port}`);
        if (reqUrl.pathname !== path) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }

        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state") ?? undefined;
        const error = reqUrl.searchParams.get("error");
        const errorDesc = reqUrl.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(`OAuth error: ${error}${errorDesc ? ` - ${errorDesc}` : ""}`);
          finish(
            new Error(
              `OAuth error: ${error}${errorDesc ? ` - ${errorDesc}` : ""}`,
            ),
          );
          return;
        }

        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Missing code");
          finish(new Error("Missing code"));
          return;
        }

        if (state && state !== expectedState) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("State mismatch");
          finish(new Error("OAuth state mismatch"));
          return;
        }

        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Twitter auth completed. You can close this tab.");
        finish(undefined, { code, state });
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });

    timer = setTimeout(() => {
      finish(new Error("Timed out waiting for Twitter OAuth callback"));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", (err: NodeJS.ErrnoException) => {
      // EADDRINUSE / EACCES / etc. should fail fast instead of hanging until timeout.
      const code = err?.code ? ` (${err.code})` : "";
      finish(
        new Error(
          `OAuth callback server error${code}: ${err?.message ?? String(err)}`,
        ),
      );
    });
    server.listen(port, url.hostname, () => {
      if (settled) {
        server.close();
        return;
      }
      logger.info(
        `Twitter OAuth callback server listening on http://${url.hostname}:${port}${path}`,
      );
    });
  });
}
