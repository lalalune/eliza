/**
 * Real owner-password login through the shipped renderer into an isolated
 * PGLite runtime, followed by the durable activation and a live-model turn.
 */

import { writeFile } from "node:fs/promises";
import type {
  AgentRuntime,
  EvaluatorRunOptions,
  EvaluatorRunResult,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";
import {
  FTU_GOAL_CONFIDENCE_THRESHOLD,
  POST_SIGN_IN_ACTIVATION_GREETING,
  POST_SIGN_IN_ACTIVATION_VERSION,
} from "@elizaos/shared";
import { expect, type Page, test } from "@playwright/test";
import { createFirstRunStateStore } from "../../../../plugins/plugin-personal-assistant/src/lifeops/first-run/state";
import { createFtuGoalStateStore } from "../../../../plugins/plugin-personal-assistant/src/lifeops/ftu-goal/state";
import { createOwnerFactStore } from "../../../../plugins/plugin-personal-assistant/src/lifeops/owner/fact-store";
import { personalAssistantPlugin } from "../../../../plugins/plugin-personal-assistant/src/plugin";
import { personalAssistantRoutesPlugin } from "../../../../plugins/plugin-personal-assistant/src/routes/plugin";
import { schedulingPlugin } from "../../../../plugins/plugin-scheduling/src/plugin";
import { getScheduledTaskRunner } from "../../../../plugins/plugin-scheduling/src/scheduled-task/runner-service";
import { createElizaPlugin } from "../../../agent/src/runtime/eliza-plugin";
import { startApiServer } from "../../../app-core/src/api/server";
import { installAgentHostBridge } from "../../../app-core/src/runtime/install-agent-host-bridge";
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
  `The problem I want us to solve is shipping the iOS version of my app by the end of September without breaking the Android release. ` +
  `Please acknowledge that you understand and include the exact marker ${PROBLEM_MARKER}; we'll plan it next.`;

type StartedApi = {
  baseUrl: string;
  provider: LiveProviderConfig;
  runtime: AgentRuntime;
  readLifeOpsEvidence: () => Promise<LifeOpsEvidence>;
  close: () => Promise<void>;
};

type LifeOpsEvidence = {
  firstRun: Awaited<
    ReturnType<ReturnType<typeof createFirstRunStateStore>["read"]>
  >;
  ftuGoal: Awaited<
    ReturnType<ReturnType<typeof createFtuGoalStateStore>["read"]>
  >;
  primaryGoal: string | null;
  primaryGoalProvenance: string | null;
  registeredEvaluators: string[];
  evaluatorRuns: Array<{
    messageId: string | null;
    messageText: string | null;
    activeEvaluators: string[];
    processedEvaluators: string[];
    errors: EvaluatorRunResult["errors"];
  }>;
  scheduledTasks: Array<{
    taskId: string;
    kind: string;
    status: string;
    idempotencyKey: string | null;
  }>;
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

async function waitForValue<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for ${label}; last=${JSON.stringify(last)}`,
  );
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
    "ELIZA_DISABLE_ACTIVITY_TRACKER",
    "ELIZA_DISABLE_PROACTIVE_AGENT",
    "ELIZA_DEVICE_KIND",
  );
  delete process.env.ELIZA_API_TOKEN;
  process.env.ELIZA_PAIRING_DISABLED = "1";
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_DEV_AUTH_BYPASS;
  process.env.ELIZA_DISABLE_ACTIVITY_TRACKER = "1";
  process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
  process.env.ELIZA_DEVICE_KIND = "desktop";

  const configEnv = useIsolatedConfigEnv("eliza-auth-activation-live-");
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>> | null =
    null;
  let bootstrapServer: Awaited<ReturnType<typeof startApiServer>> | null = null;
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;

  try {
    // Match a fresh local installation: onboarding commits durable config
    // before the first agent runtime boot. LifeOps then sees the completed
    // app setup during its normal plugin initialization instead of relying on
    // a test-only state mutation or racing a delayed reconciliation.
    installAgentHostBridge();
    bootstrapServer = await startApiServer({
      // Keep the config-only bootstrap off the renderer's fixed proxy port.
      // Playwright starts Vite before this hook; binding and immediately
      // replacing its upstream produces a real WebSocket disconnect that
      // obscures the flow under test.
      port: 0,
      skipDeferredStartupWork: true,
    });
    const bootstrapBaseUrl = `http://127.0.0.1:${bootstrapServer.port}`;
    const firstRun = await fetch(`${bootstrapBaseUrl}/api/first-run`, {
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
    await bootstrapServer.close();
    bootstrapServer = null;

    const liveProviderPlugin = await loadLiveProviderPlugin(provider);
    runtimeResult = await createRealTestRuntime({
      characterName: "ActivationE2E",
      advancedCapabilities: true,
      plugins: [
        createElizaPlugin(),
        schedulingPlugin,
        personalAssistantPlugin,
        // App-core discovers this renderer-facing companion through the plugin
        // registry. The isolated runtime mirrors that production composition
        // explicitly so the browser exercises the real LifeOps HTTP surface.
        personalAssistantRoutesPlugin,
        liveProviderPlugin,
      ],
    });
    const runtime = runtimeResult.runtime;
    const evaluatorRuns: LifeOpsEvidence["evaluatorRuns"] = [];
    const evaluatorService = (await runtime.getServiceLoadPromise(
      "evaluator",
    )) as {
      run: (
        message: Memory,
        state?: State,
        options?: EvaluatorRunOptions,
      ) => Promise<EvaluatorRunResult>;
    };
    const runEvaluator = evaluatorService.run.bind(evaluatorService);
    evaluatorService.run = async (message, state, options) => {
      const result = await runEvaluator(message, state, options);
      evaluatorRuns.push({
        messageId: typeof message.id === "string" ? message.id : null,
        messageText:
          typeof message.content.text === "string"
            ? message.content.text
            : null,
        activeEvaluators: [...result.activeEvaluators],
        processedEvaluators: [...result.processedEvaluators],
        errors: [...result.errors],
      });
      return result;
    };

    // Production installs this downward auth/session bridge before the agent
    // server starts. The live lane must do the same so the owner cookie is
    // resolved by both app-core routes and agent-owned HTTP/WebSocket routes.
    server = await startApiServer({
      port: API_PORT,
      runtime,
      skipDeferredStartupWork: true,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

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

    await waitForValue(
      "LifeOps app first-run handoff",
      () => createFirstRunStateStore(runtime).read(),
      (record) => record.status === "complete" && record.path === "app_handoff",
    );
    await waitForValue(
      "LifeOps default scheduled-task seed",
      () =>
        getScheduledTaskRunner(runtime, {
          agentId: runtime.agentId,
        }).list({}),
      (tasks) => tasks.length > 0,
    );

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
      runtime,
      readLifeOpsEvidence: async () => {
        const [firstRun, ftuGoal, ownerFacts, scheduledTasks] =
          await Promise.all([
            createFirstRunStateStore(runtime).read(),
            createFtuGoalStateStore(runtime).read(),
            createOwnerFactStore(runtime).read(),
            getScheduledTaskRunner(runtime, {
              agentId: runtime.agentId,
            }).list({}),
          ]);
        return {
          firstRun,
          ftuGoal,
          primaryGoal: ownerFacts.primaryGoal?.value ?? null,
          primaryGoalProvenance:
            ownerFacts.primaryGoal?.provenance.source ?? null,
          registeredEvaluators: runtime.evaluators.map(
            (evaluator) => evaluator.name,
          ),
          evaluatorRuns: [...evaluatorRuns],
          scheduledTasks: scheduledTasks.map((task) => ({
            taskId: task.taskId,
            kind: task.kind,
            status: task.status,
            idempotencyKey: task.idempotencyKey ?? null,
          })),
        };
      },
      close: async () => {
        await server?.close();
        await runtimeResult?.cleanup();
        await configEnv.restore();
        env.restore();
      },
    };
  } catch (error) {
    await bootstrapServer?.close().catch(() => undefined);
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
    // The shipped dev renderer reaches the isolated API through Vite's
    // same-origin proxy. Persist that production connection choice so startup
    // does not probe the default desktop port and misclassify this live lane as
    // an unreachable returning installation.
    const apiBase = location.origin;
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: `remote:${apiBase}`,
        kind: "remote",
        label: "Live auth activation API",
        apiBase,
      }),
    );
  });
}

async function readPersistedTranscripts(
  page: Page,
): Promise<PersistedTranscript[]> {
  return page.evaluate(async () => {
    const listResponse = await fetch("/api/conversations", {
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
        `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
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
  });
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
  const auditedResponses: Array<{
    method: string;
    path: string;
    status: number;
  }> = [];
  const monitorPage = (candidate: Page) => {
    candidate.on("pageerror", (error) =>
      failures.push(`pageerror: ${error.message}`),
    );
    candidate.on("console", (message) => {
      if (message.type() === "error") {
        // Chromium emits a generic duplicate for every audited HTTP failure;
        // the response listener below records the actionable method + URL.
        if (
          /^Failed to load resource: the server responded with a status of \d+/i.test(
            message.text(),
          )
        ) {
          return;
        }
        failures.push(`console: ${message.text()}`);
      }
    });
    candidate.on("response", (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (
        url.pathname.startsWith("/api/auth/") ||
        url.pathname.startsWith("/api/lifeops/") ||
        url.pathname.startsWith("/api/conversations")
      ) {
        auditedResponses.push({
          method: request.method(),
          path: `${url.pathname}${url.search}`,
          status: response.status(),
        });
      }
      if (response.status() < 400) return;
      // The unauthenticated GET is the canonical browser-session discovery
      // probe. Its 401 is asserted by the login surface and a post-login 200
      // read below; every other non-2xx remains a live-lane failure.
      if (
        response.status() === 401 &&
        request.method() === "GET" &&
        url.pathname === "/api/auth/me"
      ) {
        return;
      }
      failures.push(
        `${response.status()} ${request.method()} ${url.pathname}${url.search}`,
      );
    });
  };
  monitorPage(page);
  page.context().on("page", monitorPage);

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
    const authenticatedStatus = await page.evaluate(async () => {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
      });
      return response.status;
    });
    expect(authenticatedStatus).toBe(200);
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

    const lifeOpsEvidence = await waitForValue(
      "persisted LifeOps FTU goal",
      () => api.readLifeOpsEvidence(),
      (evidence) =>
        evidence.ftuGoal.status === "complete" ||
        evidence.evaluatorRuns.some((run) =>
          run.processedEvaluators.includes("ftu_goal_discovery"),
        ),
      120_000,
    );
    expect(lifeOpsEvidence.firstRun).toMatchObject({
      status: "complete",
      path: "app_handoff",
    });
    expect(lifeOpsEvidence.ftuGoal.status).toBe("complete");
    expect(lifeOpsEvidence.primaryGoal).toMatch(
      /iOS|app|release|shipping|ship/i,
    );
    expect(lifeOpsEvidence.primaryGoalProvenance).toBe("agent_inferred");
    expect(lifeOpsEvidence.scheduledTasks.length).toBeGreaterThan(0);
    expect(lifeOpsEvidence.ftuGoal.goal?.confidence).toBeGreaterThanOrEqual(
      FTU_GOAL_CONFIDENCE_THRESHOLD,
    );
    expect(
      lifeOpsEvidence.evaluatorRuns.some(
        (run) =>
          run.activeEvaluators.includes("ftu_goal_discovery") &&
          run.processedEvaluators.includes("ftu_goal_discovery") &&
          run.errors.length === 0,
      ),
    ).toBe(true);
    const lifeOpsArtifactPath = testInfo.outputPath(
      "lifeops-domain-artifacts.json",
    );
    await writeFile(
      lifeOpsArtifactPath,
      `${JSON.stringify(lifeOpsEvidence, null, 2)}\n`,
      "utf8",
    );
    await testInfo.attach("lifeops-domain-artifacts", {
      path: lifeOpsArtifactPath,
      contentType: "application/json",
    });

    const firstTranscripts = await readPersistedTranscripts(page);
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
    const relaunchedComposer = relaunched.getByTestId("chat-composer-textarea");
    await expect(relaunchedComposer).toBeVisible({
      timeout: 90_000,
    });
    // A cold relaunch intentionally leaves the ambient chat collapsed. Open it
    // through the shipped composer affordance before inspecting the restored
    // transcript; the activation itself must not force-open again.
    await relaunchedComposer.click();
    await expect(relaunched.getByTestId("chat-sheet")).toHaveAttribute(
      "data-detent",
      /half|full/,
    );
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

    const relaunchedTranscripts = await readPersistedTranscripts(relaunched);
    const relaunchedMessages = flattenMessages(relaunchedTranscripts);
    expect(
      relaunchedMessages.filter(
        (message) =>
          message.greetingKind === "post_sign_in_activation" &&
          message.activationVersion === POST_SIGN_IN_ACTIVATION_VERSION,
      ),
    ).toHaveLength(1);
    await attachScreenshot(relaunched, testInfo, "03-cold-relaunch-no-replay");

    const proofPath = testInfo.outputPath("auth-activation-live-proof.json");
    await writeFile(
      proofPath,
      `${JSON.stringify(
        {
          provider: {
            name: api.provider.name,
            model: api.provider.largeModel,
          },
          authenticatedStatus,
          activation: {
            text: POST_SIGN_IN_ACTIVATION_GREETING,
            version: POST_SIGN_IN_ACTIVATION_VERSION,
            persistedCount: relaunchedMessages.filter(
              (message) =>
                message.greetingKind === "post_sign_in_activation" &&
                message.activationVersion === POST_SIGN_IN_ACTIVATION_VERSION,
            ).length,
          },
          lifeOps: lifeOpsEvidence,
          transcripts: {
            beforeRelaunch: firstTranscripts,
            afterRelaunch: relaunchedTranscripts,
          },
          auditedResponses,
          failures,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await testInfo.attach("auth-activation-live-proof", {
      path: proofPath,
      contentType: "application/json",
    });

    expect(
      failures,
      `browser/API failures while using ${api.provider.name}:${api.provider.largeModel}`,
    ).toEqual([]);
  } finally {
    await page.context().close();
    await api.close();
  }
});
