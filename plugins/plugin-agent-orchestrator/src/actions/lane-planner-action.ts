/**
 * Gates multi-lane planning in front of the established TASKS create action.
 * Disabled and single-lane requests delegate byte-for-byte to TASKS; parallel
 * plans run isolated legacy invocations, aggregate their callback/state once,
 * and stamp the shared lane metadata contract on each durable task.
 */

import {
  type ActionParameters,
  type ActionResult,
  type Content,
  ElizaError,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type JsonValue,
  type Memory,
  type ProviderDataRecord,
  type Service,
  type State,
} from "@elizaos/core";
import {
  type LanePlan,
  LanePlannerService,
  type LaneSpec,
  laneTaskMetadata,
  shouldUseLanePlanner,
} from "../services/lane-planner.js";
import { shouldUseSmithersTaskRunner } from "../services/smithers-task-integration.js";
import { resolveSpawnWorkdir } from "../services/task-agent-routing.js";
import {
  contentRecord,
  messageText,
  paramsRecord,
  pickBoolean,
  pickString,
  resolveOriginatingRequestText,
} from "./common.js";
import {
  tasksAction as legacyTasksAction,
  type PlannedTaskLaneExecution,
  runPlannedTaskLane,
} from "./tasks.js";

type ResolvedLaneRoute = ReturnType<typeof resolveSpawnWorkdir>;

function operation(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): string {
  const raw = [
    params.action,
    params.op,
    params.subaction,
    params.operation,
    content.action,
    content.op,
    content.subaction,
    content.operation,
  ].find((value): value is string => typeof value === "string");
  return typeof raw === "string"
    ? raw.toLowerCase().replace(/-/g, "_")
    : "create";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toJsonValue(value: unknown, key: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, item] of value.entries()) {
      const normalized = toJsonValue(item, `${key}[${index}]`);
      if (normalized === undefined) continue;
      result.push(normalized);
    }
    return result;
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const normalized = toJsonValue(childValue, `${key}.${childKey}`);
      if (normalized !== undefined) result[childKey] = normalized;
    }
    return result;
  }
  throw new ElizaError("TASKS lane parameter is not JSON-serializable", {
    code: "LANE_PARAMETER_NOT_JSON",
    context: { key, valueType: typeof value },
  });
}

function toActionParameters(values: Record<string, unknown>): ActionParameters {
  const parameters: ActionParameters = {};
  for (const [key, value] of Object.entries(values)) {
    const normalized = toJsonValue(value, key);
    if (normalized !== undefined) parameters[key] = normalized;
  }
  return parameters;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function explicitTasks(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
): string[] | undefined {
  const agents = pickString(params, content, "agents");
  if (!agents) return undefined;
  return agents
    .split("|")
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
}

async function loadService<T extends Service>(
  runtime: IAgentRuntime,
  serviceType: string,
): Promise<T> {
  const loaded = runtime.getService<T>(serviceType);
  if (loaded) return loaded;
  if (typeof runtime.getServiceLoadPromise === "function") {
    await runtime.getServiceLoadPromise(serviceType);
  }
  const afterLoad = runtime.getService<T>(serviceType);
  if (afterLoad) return afterLoad;
  throw new ElizaError("Required orchestrator service is unavailable", {
    code: "ORCHESTRATOR_SERVICE_UNAVAILABLE",
    context: { serviceType },
  });
}

function withoutAgents(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...values };
  delete result.agents;
  return result;
}

function handlerOptions(parameters: Record<string, unknown>): HandlerOptions {
  return { parameters: toActionParameters(parameters) };
}

function cloneState(state: State | undefined): State | undefined {
  if (!state) return undefined;
  return {
    ...state,
    values: { ...state.values },
    data: { ...state.data },
  };
}

function laneMetadata(
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  plan: LanePlan,
  lane: LaneSpec,
): Record<string, unknown> {
  return {
    ...(record(content.metadata) ?? {}),
    ...(record(params.metadata) ?? {}),
    ...laneTaskMetadata(plan, lane),
  };
}

interface LaneInvocation {
  lane: LaneSpec;
  metadata: Record<string, unknown>;
  planned: PlannedTaskLaneExecution;
  message: Memory;
  options: HandlerOptions;
  state?: State;
}

function buildInvocation(
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  plan: LanePlan,
  lane: LaneSpec,
  route: ResolvedLaneRoute,
): LaneInvocation {
  const metadata = laneMetadata(params, content, plan, lane);
  const laneParameters = {
    ...withoutAgents(params),
    action: "create",
    task: lane.initialPrompt,
    title: lane.title,
    goal: lane.goal,
    acceptanceCriteria: lane.acceptanceCriteria,
    taskComplexity: lane.difficultyTag,
    metadata,
  };
  const laneContent: Content = {
    ...message.content,
    ...withoutAgents(content),
    action: "create",
    task: lane.initialPrompt,
    title: lane.title,
    goal: lane.goal,
    acceptanceCriteria: lane.acceptanceCriteria,
    taskComplexity: lane.difficultyTag,
    metadata: toJsonValue(metadata, "metadata"),
  };
  return {
    lane,
    metadata,
    planned: {
      runId: lane.runId,
      metadata,
      ...(plan.repo ? { repo: plan.repo } : {}),
      workdir: route.workdir,
      ...(route.route ? { route: route.route } : {}),
      ...(route.isolate ? { isolateWorkdir: true } : {}),
    },
    message: { ...message, content: laneContent },
    options: handlerOptions(laneParameters),
    state: cloneState(state),
  };
}

function resultTaskId(result: ActionResult): string | undefined {
  const taskId = result.data?.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}

interface ExecutedLane {
  lane: LaneSpec;
  result?: ActionResult;
  taskId?: string;
  error?: unknown;
  state?: State;
}

async function executeLane(
  runtime: IAgentRuntime,
  invocation: LaneInvocation,
): Promise<ExecutedLane> {
  try {
    const result = await runPlannedTaskLane(
      runtime,
      invocation.message,
      invocation.state,
      invocation.options,
      invocation.planned,
    );
    const taskId = resultTaskId(result);
    return {
      lane: invocation.lane,
      result,
      ...(taskId ? { taskId } : {}),
      ...(invocation.state ? { state: invocation.state } : {}),
    };
  } catch (error) {
    // error-policy:J1 each concurrent lane is translated once at the action
    // boundary so sibling results can still be returned without replaying work.
    return {
      lane: invocation.lane,
      error,
      ...(invocation.state ? { state: invocation.state } : {}),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeLaneState(state: State | undefined, lanes: ExecutedLane[]): void {
  if (!state) return;
  const sessions = lanes.flatMap((lane) => {
    const value = lane.state?.codingSessions;
    return Array.isArray(value) ? value : [];
  });
  if (sessions.length > 0) state.codingSessions = sessions;
}

function laneData(lane: ExecutedLane): ProviderDataRecord {
  const failure =
    lane.error ??
    (lane.result?.success === false
      ? (lane.result.error ?? lane.result.text)
      : undefined);
  return {
    id: lane.lane.id,
    title: lane.lane.title,
    status: failure === undefined ? "created" : "failed",
    taskId: lane.taskId ?? null,
    scope: lane.lane.scope,
    forbiddenPaths: lane.lane.forbiddenPaths,
    collisions: lane.lane.collisions,
    ...(failure === undefined ? {} : { error: errorMessage(failure) }),
  };
}

async function callbackText(
  callback: HandlerCallback | undefined,
  text: string,
): Promise<void> {
  if (callback) await callback({ text });
}

async function runParallelPlan(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
  plan: LanePlan,
  route: ResolvedLaneRoute,
): Promise<ActionResult> {
  // Build every invocation before execution so invalid structured input cannot
  // start a partial wave and then fail while preparing a later lane.
  const invocations = plan.lanes.map((lane) =>
    buildInvocation(message, state, params, content, plan, lane, route),
  );
  const executed = await Promise.all(
    invocations.map((invocation) => executeLane(runtime, invocation)),
  );
  mergeLaneState(state, executed);
  const failed = executed.filter(
    (lane) => lane.error !== undefined || lane.result?.success !== true,
  );
  for (const lane of failed) {
    runtime.reportError(
      "LanePlanner.execute",
      lane.error ?? lane.result?.error ?? lane.result?.text ?? "Lane failed",
      { waveId: plan.waveId, laneId: lane.lane.id },
    );
  }
  const widgets = executed
    .filter((lane) => lane.taskId)
    .map((lane) => `[TASK:${lane.taskId}]${lane.lane.title}[/TASK]`)
    .join("\n");
  const text =
    failed.length === 0
      ? `Created ${executed.length} task-agent lanes.${widgets ? `\n\n${widgets}` : ""}`
      : `Started ${executed.length - failed.length} of ${executed.length} task-agent lanes; ${failed.length} failed. The original request was not replayed.${widgets ? `\n\n${widgets}` : ""}`;
  let deliveryError: unknown;
  try {
    await callbackText(callback, text);
  } catch (error) {
    // error-policy:J1 lane execution is already committed, so translate result
    // delivery failure without letting the planner replay the completed wave.
    deliveryError = error;
    runtime.reportError("LanePlanner.deliver", error, {
      waveId: plan.waveId,
    });
  }
  const agents = executed.flatMap((lane) => {
    const value = lane.result?.data?.agents;
    return Array.isArray(value) ? value : [];
  });
  return {
    success: failed.length === 0 && deliveryError === undefined,
    continueChain: false,
    text,
    ...(deliveryError !== undefined
      ? { error: "LANE_RESULT_DELIVERY_FAILED" }
      : failed.length > 0
        ? { error: "LANE_EXECUTION_FAILED" }
        : {}),
    data: {
      waveId: plan.waveId,
      waveGoal: plan.waveGoal,
      lanes: executed.map(laneData),
      agents,
      suppressActionResultClipboard: true,
    },
  };
}

async function degradedSingleTask(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  params: Record<string, unknown>,
  content: Record<string, unknown>,
  callback: HandlerCallback | undefined,
  error: unknown,
): Promise<ActionResult | undefined> {
  runtime.reportError("LanePlanner.plan", error, {
    operation: "TASKS.create",
    fallback: "single-task",
  });
  const fallbackMessage: Memory = {
    ...message,
    content: {
      ...message.content,
      ...withoutAgents(content),
      agents: undefined,
    },
  };
  const result = await legacyTasksAction.handler(
    runtime,
    fallbackMessage,
    state,
    handlerOptions(withoutAgents(params)),
    callback,
  );
  if (!result) return result;
  return {
    ...result,
    data: {
      ...(result.data ?? {}),
      lanePlanner: {
        status: "degraded",
        reason: errorMessage(error),
      },
    },
  };
}

export const tasksAction: typeof legacyTasksAction = {
  ...legacyTasksAction,
  handler: async (runtime, message, state, options, callback) => {
    if (!shouldUseLanePlanner(runtime) || !shouldUseSmithersTaskRunner()) {
      return legacyTasksAction.handler(
        runtime,
        message,
        state,
        options,
        callback,
      );
    }
    const params = paramsRecord(options);
    const content = contentRecord(message);
    if (operation(params, content) !== "create") {
      return legacyTasksAction.handler(
        runtime,
        message,
        state,
        options,
        callback,
      );
    }
    let plan: LanePlan;
    let laneRoute: ResolvedLaneRoute;
    try {
      const task = pickString(params, content, "task") ?? messageText(message);
      const routingRequest = await resolveOriginatingRequestText(
        runtime,
        message,
        state,
      );
      laneRoute = resolveSpawnWorkdir(
        runtime,
        task,
        routingRequest,
        pickString(params, content, "workdir"),
        { lockWorkdir: pickBoolean(params, content, "lockWorkdir") === true },
      );
      const planner = await loadService<LanePlannerService>(
        runtime,
        LanePlannerService.serviceType,
      );
      plan = await planner.plan({
        task,
        ...(explicitTasks(params, content)
          ? { tasks: explicitTasks(params, content) }
          : {}),
        ...(pickString(params, content, "title")
          ? { title: pickString(params, content, "title") }
          : {}),
        ...(pickString(params, content, "goal")
          ? { goal: pickString(params, content, "goal") }
          : {}),
        acceptanceCriteria: stringArray(
          params.acceptanceCriteria ?? content.acceptanceCriteria,
        ),
        ...(pickString(params, content, "taskComplexity")
          ? { difficultyTag: pickString(params, content, "taskComplexity") }
          : {}),
        ...(pickString(params, content, "repo")
          ? { repo: pickString(params, content, "repo") }
          : {}),
        workdir: laneRoute.workdir,
      });
    } catch (error) {
      // error-policy:J4 planning failures intentionally degrade to one visible
      // task; degraded metadata keeps this distinct from a healthy plan.
      return degradedSingleTask(
        runtime,
        message,
        state,
        params,
        content,
        callback,
        error,
      );
    }
    if (plan.lanes.length <= 1) {
      return legacyTasksAction.handler(
        runtime,
        message,
        state,
        options,
        callback,
      );
    }
    return runParallelPlan(
      runtime,
      message,
      state,
      params,
      content,
      callback,
      plan,
      laneRoute,
    );
  },
};

// Operation-specific handles resolve to the gated TASKS action.
export const createTaskAction = tasksAction;
export const startCodingTaskAction = tasksAction;
export const spawnAgentAction = tasksAction;
export const spawnTaskAgentAction = tasksAction;
export const sendToAgentAction = tasksAction;
export const sendToTaskAgentAction = tasksAction;
export const stopAgentAction = tasksAction;
export const stopTaskAgentAction = tasksAction;
export const listAgentsAction = tasksAction;
export const listTaskAgentsAction = tasksAction;
export const cancelTaskAction = tasksAction;
export const taskHistoryAction = tasksAction;
export const taskControlAction = tasksAction;
export const taskShareAction = tasksAction;
export const provisionWorkspaceAction = tasksAction;
export const finalizeWorkspaceAction = tasksAction;
export const manageIssuesAction = tasksAction;
export const archiveCodingTaskAction = tasksAction;
export const reopenCodingTaskAction = tasksAction;
