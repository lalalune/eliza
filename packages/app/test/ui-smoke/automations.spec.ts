// @eliza-live-audit allow-route-fixtures
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type TriggerSummary = {
  id: string;
  taskId: string;
  displayName: string;
  instructions: string;
  triggerType: "interval" | "once" | "cron" | "event";
  enabled: boolean;
  wakeMode: "inject_now" | "next_autonomy_cycle";
  createdBy: string;
  eventKind?: string;
  intervalMs?: number;
  scheduledAtIso?: string;
  cronExpression?: string;
  runCount: number;
  nextRunAtMs?: number;
  updatedAt?: number;
  kind?: "prompt" | "workflow";
  workflowId?: string;
  workflowName?: string;
};

type WorkflowNode = {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  notes?: string;
  notesInFlow?: boolean;
};

type Workflow = {
  id: string;
  name: string;
  active: boolean;
  nodeCount?: number;
  nodes?: WorkflowNode[];
  connections?: Record<
    string,
    { main?: Array<Array<{ node: string; type: "main"; index: number }>> }
  >;
};

type AutomationItem = {
  id: string;
  type: "coordinator_text" | "workflow" | "automation_draft";
  source:
    | "workbench_task"
    | "trigger"
    | "workflow"
    | "workflow_draft"
    | "workflow_shadow"
    | "automation_draft";
  title: string;
  description: string;
  status: "active" | "paused" | "draft";
  enabled: boolean;
  system: boolean;
  isDraft: boolean;
  hasBackingWorkflow: boolean;
  updatedAt: string | null;
  taskId?: string;
  triggerId?: string;
  workflowId?: string;
  draftId?: string;
  trigger?: TriggerSummary;
  workflow?: Workflow;
  schedules: TriggerSummary[];
  room?: {
    conversationId: string | null;
    roomId: string;
    scope: string;
    sourceConversationId?: string;
    terminalBridgeConversationId?: string;
  };
};

type Conversation = {
  id: string;
  title: string;
  roomId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type AutomationsMockApi = {
  getCreatedTrigger: () => Record<string, unknown> | null;
  getTriggerCreateCount: () => number;
  getCreatedWorkflow: () => Record<string, unknown> | null;
  getGeneratedWorkflow: () => Record<string, unknown> | null;
  getDeletedConversationIds: () => string[];
};

type AutomationsMockOptions = {
  triggerCreateError?: { code: string; message: string };
};

const NOW_ISO = "2026-04-23T20:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

function workflowFixture(id: string, name: string, active = true): Workflow {
  return {
    id,
    name,
    active,
    nodeCount: 3,
    nodes: [
      {
        id: `${id}-trigger`,
        name: "Message event",
        type: "workflows-nodes-base.webhook",
        typeVersion: 1,
        position: [0, 0],
        parameters: { path: "message.received" },
        notes: "Receives a normalized message event.",
        notesInFlow: true,
      },
      {
        id: `${id}-summarize`,
        name: "Summarize",
        type: "workflows-nodes-base.code",
        typeVersion: 1,
        position: [320, 0],
        parameters: { prompt: "Summarize the message." },
        notes: "Turns the event payload into a short summary.",
        notesInFlow: true,
      },
      {
        id: `${id}-send`,
        name: "Send digest",
        type: "workflows-nodes-base.httpRequest",
        typeVersion: 1,
        position: [640, 0],
        parameters: { channel: "inbox" },
        notes: "Posts the summary to the destination channel.",
        notesInFlow: true,
      },
    ],
    connections: {
      "Message event": {
        main: [[{ node: "Summarize", type: "main", index: 0 }]],
      },
      Summarize: {
        main: [[{ node: "Send digest", type: "main", index: 0 }]],
      },
    },
  };
}

function eventTaskItem(): AutomationItem {
  const trigger: TriggerSummary = {
    id: "trigger-event-message",
    taskId: "task-trigger-event-message",
    displayName: "Message triage",
    instructions: "Summarize each inbound message.",
    triggerType: "event",
    eventKind: "message.received",
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "playwright",
    runCount: 0,
    updatedAt: Date.parse(NOW_ISO),
    kind: "prompt",
  };
  return {
    id: "trigger:trigger-event-message",
    type: "coordinator_text",
    source: "trigger",
    title: "Message triage",
    description: "Summarize each inbound message.",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: false,
    updatedAt: NOW_ISO,
    taskId: trigger.taskId,
    triggerId: trigger.id,
    trigger,
    schedules: [trigger],
  };
}

function workflowItem(workflow: Workflow): AutomationItem {
  const schedule: TriggerSummary = {
    id: `trigger-${workflow.id}`,
    taskId: `task-${workflow.id}`,
    displayName: `Run ${workflow.name}`,
    instructions: `Run workflow ${workflow.name}`,
    triggerType: "interval",
    intervalMs: HOUR_MS,
    enabled: true,
    wakeMode: "inject_now",
    createdBy: "playwright",
    runCount: 1,
    nextRunAtMs: Date.parse(NOW_ISO) + HOUR_MS,
    updatedAt: Date.parse(NOW_ISO),
    kind: "workflow",
    workflowId: workflow.id,
    workflowName: workflow.name,
  };
  return {
    id: `workflow:${workflow.id}`,
    type: "workflow",
    source: "workflow",
    title: workflow.name,
    description: "",
    status: workflow.active ? "active" : "paused",
    enabled: workflow.active,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: NOW_ISO,
    workflowId: workflow.id,
    workflow,
    schedules: [schedule],
    room: {
      conversationId: `conversation-${workflow.id}`,
      roomId: `room-${workflow.id}`,
      scope: "automation-workflow",
    },
  };
}

function draftWorkflowItem(
  draftId = "draft-existing",
  conversationId = "conversation-draft-existing",
): AutomationItem {
  return {
    id: `workflow-draft:${draftId}`,
    type: "automation_draft",
    source: "workflow_draft",
    title: "Draft",
    description: "",
    status: "draft",
    enabled: false,
    system: false,
    isDraft: true,
    hasBackingWorkflow: false,
    updatedAt: NOW_ISO,
    workflowId: draftId,
    draftId,
    schedules: [],
    room: {
      conversationId,
      roomId: `room-${draftId}`,
      scope: "automation-workflow-draft",
    },
  };
}

function automationSummary(automations: AutomationItem[]) {
  return {
    total: automations.length,
    coordinatorCount: automations.filter(
      (item) => item.type !== "workflow_service",
    ).length,
    workflowCount: automations.filter((item) => item.type === "workflow")
      .length,
    scheduledCount: automations.reduce(
      (count, item) => count + item.schedules.length,
      0,
    ),
    draftCount: automations.filter((item) => item.isDraft).length,
  };
}

async function installAutomationsApi(
  page: Page,
  initialAutomations: AutomationItem[],
  options: AutomationsMockOptions = {},
): Promise<AutomationsMockApi> {
  let automations = [...initialAutomations];
  const workflows = new Map<string, Workflow>();
  const conversations = new Map<string, Conversation>();
  let createdTrigger: Record<string, unknown> | null = null;
  let triggerCreateCount = 0;
  let createdWorkflow: Record<string, unknown> | null = null;
  let generatedWorkflow: Record<string, unknown> | null = null;
  const deletedConversationIds: string[] = [];

  for (const item of automations) {
    if (item.workflowId && item.workflow) {
      workflows.set(item.workflowId, item.workflow);
    }
    if (item.room?.conversationId) {
      conversations.set(item.room.conversationId, {
        id: item.room.conversationId,
        title: item.title,
        roomId: item.room.roomId,
        metadata: {
          scope: item.room.scope,
          workflowId: item.hasBackingWorkflow ? item.workflowId : undefined,
          draftId: item.draftId,
        },
        createdAt: item.updatedAt ?? NOW_ISO,
        updatedAt: item.updatedAt ?? NOW_ISO,
      });
    }
  }

  const fulfillJson = async (
    route: Parameters<Page["route"]>[1] extends (route: infer R) => unknown
      ? R
      : never,
    body: unknown,
    status = 200,
  ) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };

  await page.route("**/api/automations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      automations,
      summary: automationSummary(automations),
      workflowStatus: {
        mode: "local",
        host: "http://127.0.0.1:5678",
        status: "ready",
        cloudConnected: false,
        localEnabled: true,
        platform: "desktop",
        cloudHealth: "unknown",
      },
      workflowFetchError: null,
    });
  });

  await page.route("**/api/automations/nodes", async (route) => {
    await fulfillJson(route, {
      nodes: [
        {
          id: "lifeops:message",
          label: "Message Event",
          description: "Normalized message input",
          class: "trigger",
          source: "lifeops_event",
          backingCapability: "message.received",
          ownerScoped: true,
          requiresSetup: false,
          availability: "enabled",
        },
      ],
      summary: { total: 1, enabled: 1, disabled: 0 },
    });
  });

  await page.route("**/api/triggers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/triggers") {
      await fulfillJson(route, {
        triggers: automations
          .map((item) => item.trigger ?? item.schedules[0])
          .filter(Boolean),
      });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/runs")) {
      await fulfillJson(route, { runs: [] });
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/triggers/health") {
      await fulfillJson(route, {
        triggersEnabled: true,
        activeTriggers: 0,
        disabledTriggers: 0,
        totalExecutions: 0,
        totalFailures: 0,
        totalSkipped: 0,
      });
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/triggers") {
      triggerCreateCount += 1;
      createdTrigger = request.postDataJSON() as Record<string, unknown>;
      if (options.triggerCreateError) {
        await fulfillJson(
          route,
          {
            error: options.triggerCreateError.message,
            code: options.triggerCreateError.code,
          },
          409,
        );
        return;
      }
      const trigger: TriggerSummary = {
        id: "trigger-created",
        taskId: "task-trigger-created",
        displayName: String(createdTrigger.displayName ?? "Created task"),
        instructions: String(createdTrigger.instructions ?? ""),
        triggerType:
          createdTrigger.triggerType as TriggerSummary["triggerType"],
        eventKind:
          typeof createdTrigger.eventKind === "string"
            ? createdTrigger.eventKind
            : undefined,
        scheduledAtIso:
          typeof createdTrigger.scheduledAtIso === "string"
            ? createdTrigger.scheduledAtIso
            : undefined,
        cronExpression:
          typeof createdTrigger.cronExpression === "string"
            ? createdTrigger.cronExpression
            : undefined,
        enabled: true,
        wakeMode: "inject_now",
        createdBy: "playwright",
        runCount: 0,
        updatedAt: Date.parse(NOW_ISO),
        kind: "prompt",
      };
      automations = [
        ...automations,
        {
          id: `trigger:${trigger.id}`,
          type: "coordinator_text",
          source: "trigger",
          title: trigger.displayName,
          description: trigger.instructions,
          status: "active",
          enabled: true,
          system: false,
          isDraft: false,
          hasBackingWorkflow: false,
          updatedAt: NOW_ISO,
          triggerId: trigger.id,
          trigger,
          schedules: [trigger],
        },
      ];
      await fulfillJson(route, { trigger }, 201);
      return;
    }
    await fulfillJson(route, { ok: true });
  });

  await page.route("**/api/workflow/workflows**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/workflow/workflows") {
      await fulfillJson(route, {
        workflows: [...workflows.values()],
      });
      return;
    }

    if (request.method() === "POST" && path === "/api/workflow/workflows") {
      createdWorkflow = request.postDataJSON() as Record<string, unknown>;
      const copy = workflowFixture(
        "workflow-copy",
        String(createdWorkflow.name ?? "Workflow Copy"),
      );
      workflows.set(copy.id, copy);
      automations = [...automations, workflowItem(copy)];
      await fulfillJson(route, copy);
      return;
    }

    if (
      request.method() === "POST" &&
      path === "/api/workflow/workflows/generate"
    ) {
      generatedWorkflow = request.postDataJSON() as Record<string, unknown>;
      const workflow = workflowFixture(
        "workflow-generated",
        "Generated workflow",
      );
      workflows.set(workflow.id, workflow);
      automations = [
        ...automations.filter((item) => !item.isDraft),
        workflowItem(workflow),
      ];
      await fulfillJson(route, workflow);
      return;
    }

    const workflowId = decodeURIComponent(path.split("/").pop() ?? "");
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      await fulfillJson(route, { error: "not found" }, 404);
      return;
    }
    await fulfillJson(route, workflow);
  });

  await page.route("**/api/conversations**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/conversations") {
      await fulfillJson(route, { conversations: [...conversations.values()] });
      return;
    }

    if (request.method() === "POST" && path === "/api/conversations") {
      const body = request.postDataJSON() as {
        title?: string;
        metadata?: Record<string, unknown>;
      };
      const conversation: Conversation = {
        id: `conversation-${conversations.size + 1}`,
        title: body.title ?? "Automation",
        roomId: `room-${conversations.size + 1}`,
        metadata: body.metadata,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      };
      conversations.set(conversation.id, conversation);
      const draftId =
        typeof body.metadata?.draftId === "string"
          ? body.metadata.draftId
          : `draft-${conversations.size}`;
      automations = [
        ...automations,
        draftWorkflowItem(draftId, conversation.id),
      ];
      await fulfillJson(route, { conversation });
      return;
    }

    const conversationId = decodeURIComponent(path.split("/").pop() ?? "");
    if (request.method() === "PATCH") {
      const existing = conversations.get(conversationId);
      const body = request.postDataJSON() as Partial<Conversation>;
      const conversation: Conversation = {
        ...(existing ?? {
          id: conversationId,
          roomId: `room-${conversationId}`,
          createdAt: NOW_ISO,
        }),
        title: body.title ?? existing?.title ?? "Automation",
        metadata: body.metadata ?? existing?.metadata,
        updatedAt: NOW_ISO,
      };
      conversations.set(conversation.id, conversation);
      await fulfillJson(route, { conversation });
      return;
    }

    if (request.method() === "DELETE") {
      deletedConversationIds.push(conversationId);
      conversations.delete(conversationId);
      automations = automations.filter(
        (item) => item.room?.conversationId !== conversationId,
      );
      await fulfillJson(route, { ok: true });
      return;
    }

    await fulfillJson(route, { error: "not found" }, 404);
  });

  return {
    getCreatedTrigger: () => createdTrigger,
    getTriggerCreateCount: () => triggerCreateCount,
    getCreatedWorkflow: () => createdWorkflow,
    getGeneratedWorkflow: () => generatedWorkflow,
    getDeletedConversationIds: () => [...deletedConversationIds],
  };
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("automations overview empty state encourages creating tasks and workflows", async ({
  page,
}) => {
  await installAutomationsApi(page, []);

  await openAppPath(page, "/automations");

  await expect(page.getByTestId("automations-shell")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Automations" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Prompts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Workflows", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Nothing scheduled yet")).toBeVisible();

  await expect(page.getByRole("button", { name: "New" })).toHaveCount(0);
  await expect(page.getByTestId("automations-shell")).toBeVisible();
});

test("automations empty state remains reachable beside chat in short landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await installAutomationsApi(page, []);

  await openAppPath(page, "/automations");

  const scrollRegion = page.getByTestId("automations-scroll-region");
  const headline = page.getByText("Nothing scheduled yet");
  await expect(scrollRegion).toBeVisible();
  await expect(headline).toBeAttached();
  await page.waitForFunction(
    () =>
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--eliza-continuous-chat-side-clearance",
        ),
      ) > 0,
  );

  await expect(headline).toBeVisible();
  await expect(
    page.getByText("Ask in chat to set up a workflow and it will run here."),
  ).toBeVisible();

  const geometry = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(
      '[data-testid="automations-scroll-region"]',
    );
    const title = Array.from(document.querySelectorAll<HTMLElement>("p")).find(
      (element) => element.textContent?.trim() === "Nothing scheduled yet",
    );
    const empty = document.querySelector<HTMLElement>(
      '[data-testid="automations-empty-state"]',
    );
    const chat = document.querySelector<HTMLElement>(
      '[data-testid="chat-sheet"]',
    );
    if (!scroll || !title || !empty || !chat) return null;
    const titleRect = title.getBoundingClientRect();
    const emptyRect = empty.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    const overlapWidth = Math.max(
      0,
      Math.min(emptyRect.right, chatRect.right) -
        Math.max(emptyRect.left, chatRect.left),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(emptyRect.bottom, chatRect.bottom) -
        Math.max(emptyRect.top, chatRect.top),
    );
    return {
      scrollTop: scroll.scrollTop,
      emptyBottom: emptyRect.bottom,
      titleTop: titleRect.top,
      titleBottom: titleRect.bottom,
      viewportHeight: window.innerHeight,
      overlapArea: overlapWidth * overlapHeight,
      sidePadding: Number.parseFloat(getComputedStyle(scroll).paddingInlineEnd),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.scrollTop).toBe(0);
  expect(geometry?.emptyBottom).toBeLessThanOrEqual(
    geometry?.viewportHeight ?? 0,
  );
  expect(geometry?.titleTop).toBeGreaterThanOrEqual(0);
  expect(geometry?.titleBottom).toBeLessThanOrEqual(
    geometry?.viewportHeight ?? 0,
  );
  expect(geometry?.overlapArea).toBe(0);
  expect(geometry?.sidePadding).toBeGreaterThan(0);
});

test("automations can list prompts, create a one-time trigger, and inspect workflow JSON", async ({
  page,
}) => {
  const workflow = workflowFixture(
    "workflow-message-pipeline",
    "Message pipeline",
  );
  const api = await installAutomationsApi(page, [
    eventTaskItem(),
    workflowItem(workflow),
  ]);

  await openAppPath(page, "/automations");

  await expect(page.getByRole("tab", { name: "Prompts 1" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Workflows 1" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Message triage" }),
  ).toBeVisible();
  // The row's accessible name is its full text ("Message pipeline Active …"),
  // which collides with the sibling "Run …" button under a bare-title role query.
  // Target the open control by its stable agent-surface label instead
  // (useAgentElement stamps data-agent-label="Open <title>").
  const openMessagePipeline = page.locator(
    '[data-agent-label="Open Message pipeline"]',
  );
  await expect(openMessagePipeline).toBeVisible();

  await openMessagePipeline.click();
  await expect(
    page.getByRole("heading", { name: "Message pipeline" }),
  ).toBeVisible();
  await expect(page.getByTestId("workflow-editor-json")).toHaveValue(
    /Message pipeline/,
  );
  await expect(page.getByText("Graph")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // The chooser was removed; open the New TaskEditor directly via the automations
  // hash deep-link (#automations/task/__new__, parsed by useAutomationDeepLink).
  await page.evaluate(() => {
    window.location.hash = "#automations/task/__new__";
  });
  await page.getByTestId("task-editor-name").fill("Escalate inbound messages");
  await page
    .getByTestId("task-editor-prompt")
    .fill("Summarize inbound messages and flag urgent ones.");
  await page.getByTestId("task-editor-scheduled-at").fill("2099-04-24T09:00");
  await page.getByTestId("task-editor-save").click();
  await expect
    .poll(() => api.getCreatedTrigger())
    .toMatchObject({
      kind: "prompt",
      displayName: "Escalate inbound messages",
      instructions: "Summarize inbound messages and flag urgent ones.",
      triggerType: "once",
    });
  expect(api.getTriggerCreateCount()).toBe(1);
  const scheduledAtIso = api.getCreatedTrigger()?.scheduledAtIso;
  expect(typeof scheduledAtIso).toBe("string");
  expect(Date.parse(String(scheduledAtIso))).toBeGreaterThan(Date.now());
  await expect(page.getByText("Escalate inbound messages")).toBeVisible();
});

// Workflow generation is a backend-only capability. This smoke suite exercises
// the editor's direct workflow JSON surface; the shared fixture retains the
// generation route because it also models the complete workflow API boundary.

// Event-triggered automation coverage.
//
// The editor and list share the canonical prompt-trigger representation: the
// seeded event supplies the available event catalog entry, and the new row is
// persisted through `/api/triggers` before the aggregate list refreshes.
test("automations renders an event trigger and creates a new event automation", async ({
  page,
}) => {
  const api = await installAutomationsApi(page, [eventTaskItem()]);

  await openAppPath(page, "/automations");

  // The seeded event task renders with its event-kind schedule label.
  await expect(
    page.getByRole("button", { name: "Message triage" }),
  ).toBeVisible();
  await expect(page.getByText("On message.received")).toBeVisible();

  // Create a fresh event-triage automation through the real editor flow. The
  // chooser was removed; open the New TaskEditor directly via the hash deep-link.
  await page.evaluate(() => {
    window.location.hash = "#automations/task/__new__";
  });
  await page.getByTestId("task-editor-name").fill("Triage new chat events");
  await page
    .getByTestId("task-editor-prompt")
    .fill("When a chat message arrives, summarize and route it.");
  await page.getByText("On event", { exact: true }).click();
  await page.getByTestId("task-editor-save").click();

  await expect
    .poll(() => api.getCreatedTrigger())
    .toMatchObject({
      kind: "prompt",
      displayName: "Triage new chat events",
      instructions: "When a chat message arrives, summarize and route it.",
      triggerType: "event",
      eventKind: "message.received",
    });
  expect(api.getTriggerCreateCount()).toBe(1);

  await expect(page.getByText("Triage new chat events")).toBeVisible();
});

test("a fresh account can create its first event prompt trigger", async ({
  page,
}) => {
  const api = await installAutomationsApi(page, []);

  await openAppPath(page, "/automations");
  await page.evaluate(() => {
    window.location.hash = "#automations/task/__new__";
  });

  await page.getByTestId("task-editor-name").fill("Fresh event automation");
  await page
    .getByTestId("task-editor-prompt")
    .fill("Summarize the first incoming message.");
  await page.getByText("On event", { exact: true }).click();
  await expect(page.getByTestId("task-editor-event")).toBeVisible();
  await page.getByTestId("task-editor-save").click();

  await expect
    .poll(() => api.getCreatedTrigger())
    .toMatchObject({
      kind: "prompt",
      displayName: "Fresh event automation",
      instructions: "Summarize the first incoming message.",
      triggerType: "event",
      eventKind: "message.received",
    });
  expect(api.getTriggerCreateCount()).toBe(1);
  await expect(
    page.locator('[data-agent-label="Open Fresh event automation"]'),
  ).toBeVisible();
});

test("time-based prompt rejection explains always-on hourly credits", async ({
  page,
}) => {
  const api = await installAutomationsApi(page, [], {
    triggerCreateError: {
      code: "workflow_requires_always_on",
      message:
        "Scheduled prompt automations require an always-on agent runtime.",
    },
  });

  await openAppPath(page, "/automations");
  await page.evaluate(() => {
    window.location.hash = "#automations/task/__new__";
  });
  await page.getByTestId("task-editor-name").fill("Morning digest");
  await page.getByTestId("task-editor-prompt").fill("Summarize my calendar");
  await page.getByTestId("task-editor-scheduled-at").fill("2099-04-24T09:00");
  await page.getByTestId("task-editor-save").click();

  const notice = page.getByTestId("task-always-on-required");
  await expect(notice).toContainText("Always-on agent required");
  await expect(notice).toContainText("continuous hourly credit usage");
  expect(api.getTriggerCreateCount()).toBe(1);
});
