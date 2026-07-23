/**
 * Real owner-password login through the shipped renderer into an isolated
 * PGLite runtime, followed by the durable activation and a live-model turn.
 */

import type { Plugin } from "@elizaos/core";
import {
  POST_SIGN_IN_ACTIVATION_GREETING,
  POST_SIGN_IN_ACTIVATION_VERSION,
} from "@elizaos/shared";
import { expect, type Page, test } from "@playwright/test";
import { startApiServer } from "../../../app-core/src/api/server";
import { useIsolatedConfigEnv } from "../../../app-core/test/helpers/isolated-config";
import {
  type LiveProviderConfig,
  selectLiveProviderAsync,
} from "../../../app-core/test/helpers/live-provider";
import { createRealTestRuntime } from "../../../app-core/test/helpers/real-runtime";
import { saveEnv } from "../../../app-core/test/helpers/test-utils";

const OWNER_NAME = "Activation Owner";
const OWNER_PASSWORD = "owner activation password 2026!";
const API_PORT = Number(
  process.env.ELIZA_AUTH_ACTIVATION_API_PORT || process.env.ELIZA_API_PORT,
);
const PROBLEM_MARKER = "OWNER_ACTIVATION_LIVE_OK";
const CONCRETE_PROBLEM =
  `I have a concrete problem: plan a two-week launch checklist for a small open-source release. ` +
  `Acknowledge the problem and include the exact marker ${PROBLEM_MARKER}.`;

type StartedApi = {
  baseUrl: string;
  provider: LiveProviderConfig;
  close: () => Promise<void>;
};

type PersistedMessage = {
  role?: string;
  text?: string;
  greetingKind?: string;
  activationVersion?: string;
};

type PersistedTranscript = {
  conversationId: string;
  messages: PersistedMessage[];
};

function liveProviderDiagnostic(): string {
  return [
    "The real auth-activation E2E lane requires a live LLM provider.",
    "Set one supported credential (for example CEREBRAS_API_KEY with",
    "ELIZA_PROVIDER=cerebras, OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY,",
    "GOOGLE_GENERATIVE_AI_API_KEY, or OPENROUTER_API_KEY), then rerun",
    "`bun run --cwd packages/app test:e2e:auth-activation:live`.",
  ].join(" ");
}

async function requireLiveProvider(): Promise<LiveProviderConfig> {
  const provider = await selectLiveProviderAsync();
  if (!provider) {
    throw new Error(liveProviderDiagnostic());
  }
  for (const [key, value] of Object.entries(provider.env)) {
    process.env[key] = value;
  }
  return provider;
}

async function loadLiveProviderPlugin(
  provider: LiveProviderConfig,
): Promise<Plugin> {
  switch (provider.name) {
    case "cerebras":
    case "openai":
    case "local-llama-cpp":
      return (await import("../../../../plugins/plugin-openai/index.ts"))
        .default;
    case "anthropic":
      return (await import("../../../../plugins/plugin-anthropic/index.ts"))
        .default;
    case "groq":
      return (await import("../../../../plugins/plugin-groq/index.ts")).default;
    case "google":
      return (await import("../../../../plugins/plugin-google-genai/index.ts"))
        .default;
    case "openrouter":
      return (await import("../../../../plugins/plugin-openrouter/index.ts"))
        .default;
    case "cli":
      return (await import("../../../../plugins/plugin-cli-inference/index.ts"))
        .default;
  }
}

async function expectOk(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    throw new Error(
      `${label} failed with ${response.status}: ${await response.text()}`,
    );
  }
}

async function startOwnerApi(): Promise<StartedApi> {
  const provider = await requireLiveProvider();
  const env = saveEnv(
    "ELIZA_API_TOKEN",
    "ELIZA_PAIRING_DISABLED",
    "ELIZA_REQUIRE_LOCAL_AUTH",
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_DEV_AUTH_BYPASS",
    "ELIZA_CONFIG_PATH",
  );
  delete process.env.ELIZA_API_TOKEN;
  process.env.ELIZA_PAIRING_DISABLED = "1";
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_DEV_AUTH_BYPASS;

  const configEnv = useIsolatedConfigEnv("eliza-auth-activation-live-");
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>> | null =
    null;
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;

  try {
    const liveProviderPlugin = await loadLiveProviderPlugin(provider);
    runtimeResult = await createRealTestRuntime({
      characterName: "ActivationE2E",
      plugins: [liveProviderPlugin],
    });

    server = await startApiServer({
      port: API_PORT,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const firstRun = await fetch(`${baseUrl}/api/first-run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "ActivationE2E",
        bio: ["A live owner sign-in and activation E2E agent."],
        systemPrompt:
          "Be concise. Follow exact marker instructions in E2E prompts.",
        language: "en",
        presetId: "default",
        avatarIndex: 0,
      }),
    });
    await expectOk(firstRun, "first-run completion");
    const firstRunStatus = await fetch(`${baseUrl}/api/first-run/status`);
    await expectOk(firstRunStatus, "first-run status");
    const firstRunState = (await firstRunStatus.json()) as {
      complete?: boolean;
    };
    if (firstRunState.complete !== true) {
      throw new Error(
        `first-run status did not persist completion: ${JSON.stringify(firstRunState)}`,
      );
    }

    const setup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: OWNER_NAME,
        password: OWNER_PASSWORD,
      }),
    });
    await expectOk(setup, "owner setup");

    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";

    return {
      baseUrl,
      provider,
      close: async () => {
        await server?.close();
        await runtimeResult?.cleanup();
        await configEnv.restore();
        env.restore();
      },
    };
  } catch (error) {
    await server?.close().catch(() => undefined);
    await runtimeResult?.cleanup().catch(() => undefined);
    await configEnv.restore().catch(() => undefined);
    env.restore();
    throw error;
  }
}

async function seedCompletedFirstRun(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("eliza:first-run-complete", "1");
    localStorage.setItem("eliza:setup:step", "activate");
    localStorage.setItem("eliza:ui-shell-mode", "native");
    localStorage.setItem("eliza:chat:voiceMuted", "true");
    localStorage.removeItem("elizaos:active-server");
  });
}

async function readPersistedTranscripts(
  page: Page,
  baseUrl: string,
): Promise<PersistedTranscript[]> {
  return page.evaluate(async (apiBase) => {
    const listResponse = await fetch(`${apiBase}/api/conversations`, {
      credentials: "include",
    });
    if (!listResponse.ok) {
      throw new Error(
        `conversation list failed with ${listResponse.status}: ${await listResponse.text()}`,
      );
    }
    const list = (await listResponse.json()) as {
      conversations?: Array<{ id?: string }>;
    };
    const transcripts: Array<{
      conversationId: string;
      messages: PersistedMessage[];
    }> = [];
    for (const conversation of list.conversations ?? []) {
      if (!conversation.id) continue;
      const response = await fetch(
        `${apiBase}/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
        { credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(
          `message history failed with ${response.status}: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as {
        messages?: PersistedMessage[];
      };
      transcripts.push({
        conversationId: conversation.id,
        messages: body.messages ?? [],
      });
    }
    return transcripts;
  }, baseUrl);
}

function flattenMessages(
  transcripts: PersistedTranscript[],
): PersistedMessage[] {
  return transcripts.flatMap((transcript) => transcript.messages);
}

async function attachScreenshot(
  page: Page,
  testInfo: import("@playwright/test").TestInfo,
  name: string,
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("owner signs in, gets one activation, solves a problem, and relaunches without replay", async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const api = await startOwnerApi();
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });

  try {
    await seedCompletedFirstRun(page);
    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: /^Sign in$/i })).toBeVisible(
      {
        timeout: 90_000,
      },
    );
    await page.getByLabel("Display name").fill(OWNER_NAME);
    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByLabel(/Remember this device/i).click();
    await page.getByRole("button", { name: /^Sign in$/i }).click();

    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
      timeout: 90_000,
    });
    const activation = page
      .getByTestId("thread-line")
      .filter({ hasText: POST_SIGN_IN_ACTIVATION_GREETING });
    await expect(activation).toHaveCount(1, { timeout: 90_000 });
    await attachScreenshot(page, testInfo, "01-owner-signed-in-activation");

    const composer = page.getByTestId("chat-composer-textarea");
    await composer.fill(CONCRETE_PROBLEM);
    await composer.press("Enter");
    const liveReply = page
      .locator('[data-testid="thread-line"][data-role="assistant"]')
      .filter({ hasText: PROBLEM_MARKER });
    await expect(liveReply.first()).toBeVisible({ timeout: 180_000 });
    await attachScreenshot(page, testInfo, "02-live-problem-reply");

    const firstTranscripts = await readPersistedTranscripts(page, api.baseUrl);
    const firstMessages = flattenMessages(firstTranscripts);
    expect(
      firstMessages.filter(
        (message) =>
          message.greetingKind === "post_sign_in_activation" &&
          message.activationVersion === POST_SIGN_IN_ACTIVATION_VERSION &&
          message.text === POST_SIGN_IN_ACTIVATION_GREETING,
      ),
    ).toHaveLength(1);
    expect(
      firstMessages.some((message) => message.text === CONCRETE_PROBLEM),
    ).toBe(true);
    expect(
      firstMessages.some(
        (message) =>
          message.role === "assistant" &&
          message.text?.includes(PROBLEM_MARKER),
      ),
    ).toBe(true);

    const context = page.context();
    await page.close();
    const relaunched = await context.newPage();
    await relaunched.goto("/chat", { waitUntil: "domcontentloaded" });
    await expect(relaunched.getByTestId("chat-composer-textarea")).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      relaunched
        .getByTestId("thread-line")
        .filter({ hasText: POST_SIGN_IN_ACTIVATION_GREETING }),
    ).toHaveCount(1, { timeout: 90_000 });
    await expect(
      relaunched
        .getByTestId("thread-line")
        .filter({ hasText: CONCRETE_PROBLEM }),
    ).toHaveCount(1);
    await expect(
      relaunched
        .locator('[data-testid="thread-line"][data-role="assistant"]')
        .filter({ hasText: PROBLEM_MARKER }),
    ).toHaveCount(1);

    const relaunchedTranscripts = await readPersistedTranscripts(
      relaunched,
      api.baseUrl,
    );
    const relaunchedMessages = flattenMessages(relaunchedTranscripts);
    expect(
      relaunchedMessages.filter(
        (message) =>
          message.greetingKind === "post_sign_in_activation" &&
          message.activationVersion === POST_SIGN_IN_ACTIVATION_VERSION,
      ),
    ).toHaveLength(1);
    await attachScreenshot(relaunched, testInfo, "03-cold-relaunch-no-replay");

    expect(
      failures,
      `browser/API failures while using ${api.provider.name}:${api.provider.largeModel}`,
    ).toEqual([]);
  } finally {
    await api.close();
  }
});
