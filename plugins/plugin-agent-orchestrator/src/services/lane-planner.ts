/**
 * Decomposes one coding goal into durable, non-overlapping lane specifications.
 * The service gathers collision truth from the existing task and workspace
 * services before it emits a parallel plan; pure helpers own deterministic
 * decomposition so the safety contract remains testable without a runtime.
 */

import { randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  ModelType,
  Service,
} from "@elizaos/core";
import { staticAcceptanceCriteria } from "./acceptance-criteria.js";
import {
  standardLaneForbiddenPaths,
  standardLaneForbiddenReason,
} from "./diff-review-gate.js";
import { parseJsonObjectResponse } from "./json-model-output.js";
import { OrchestratorTaskService } from "./orchestrator-task-service.js";
import { parseOwnerRepo } from "./workspace-github.js";
import { CodingWorkspaceService } from "./workspace-service.js";

export const LANE_PLANNER_SERVICE_TYPE = "ORCHESTRATOR_LANE_PLANNER";
export const LANE_PLANNER_SETTING = "ELIZA_ORCHESTRATOR_LANE_PLANNER";
export const LANE_PLANNER_REFINE_SETTING =
  "ELIZA_ORCHESTRATOR_LANE_PLANNER_REFINE";

const MAX_LANES = 6;
const TERMINAL_TASK_STATUSES = new Set(["done", "failed", "archived"]);

export type LaneCollisionSourceType = "open-pr" | "active-lane" | "sibling";

export interface LaneCollision {
  source: LaneCollisionSourceType;
  id: string;
  paths: string[];
  title?: string;
  url?: string;
}

export interface LaneSpec {
  id: string;
  /** Stable Smithers run identity for this durable task lane. */
  runId: string;
  title: string;
  goal: string;
  /** Canonical owned file/directory scope. */
  scope: string[];
  forbiddenPaths: string[];
  collisions: LaneCollision[];
  difficultyTag: "simple" | "moderate" | "hard";
  acceptanceCriteria: string[];
  initialPrompt: string;
}

export interface LanePlan {
  waveId: string;
  waveGoal: string;
  repo?: string;
  workdir?: string;
  lanes: LaneSpec[];
}

export interface LaneRepositoryContext {
  workdir?: string;
  repo?: string;
  excludeTaskIds?: string[];
}

export interface ExternalLaneCollision {
  source: Exclude<LaneCollisionSourceType, "sibling">;
  id: string;
  paths: string[];
  title?: string;
  url?: string;
}

export interface LaneCollisionSource {
  listCollisions(
    input: LaneRepositoryContext,
  ): Promise<ExternalLaneCollision[]>;
}

export interface LaneRepositoryResolver {
  resolveRepository(input: LaneRepositoryContext): Promise<string>;
}

export interface LanePlannerInput extends LaneRepositoryContext {
  task: string;
  tasks?: string[];
  title?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  difficultyTag?: string;
  waveId?: string;
}

/** One canonical metadata shape shared by the planner and wave supervisor. */
export interface LaneTaskMetadata {
  waveId: string;
  waveGoal: string;
  waveGoalMet: boolean;
  laneId: string;
  laneRunId: string;
  laneTitle: string;
  laneScope: string[];
  forbiddenPaths: string[];
  laneCollisions: LaneCollision[];
  difficultyTag: LaneSpec["difficultyTag"];
}

export interface WaveGoalEvaluation {
  met: boolean;
  evidenceTaskIds: string[];
}

export interface WaveRefillTaskView {
  id: string;
  title: string;
  goal: string;
  status: string;
  acceptanceCriteria: string[];
  metadata: Record<string, unknown>;
  latestWorkdir?: string | null;
  latestRepo?: string | null;
}

export interface WaveRefillRequest {
  waveId: string;
  waveGoal: string;
  terminalLane: WaveRefillTaskView;
  activeLanes: WaveRefillTaskView[];
  collisions: Array<{ key?: string; paths: string[] }>;
  waveGoalEvaluation?: WaveGoalEvaluation;
  salvagePath?: string;
  salvageChangedFiles?: string[];
}

export interface WaveReplacementSpec {
  title: string;
  goal: string;
  initialPrompt: string;
  scope: string[];
  forbiddenPaths: string[];
  acceptanceCriteria: string[];
  difficultyTag: LaneSpec["difficultyTag"];
  metadata: LaneTaskMetadata;
}

function isEnabledValue(value: unknown): boolean {
  if (value === true) return true;
  return (
    typeof value === "string" &&
    ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
  );
}

function readSetting(runtime: IAgentRuntime | undefined, key: string): unknown {
  return runtime?.getSetting?.(key) ?? process.env[key];
}

export function shouldUseLanePlanner(runtime?: IAgentRuntime): boolean {
  return isEnabledValue(readSetting(runtime, LANE_PLANNER_SETTING));
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) return null;
    values.push(item.trim());
  }
  return values;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127);
  });
}

function hasInvalidMetadataTextControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code === 0 || code === 127;
  });
}

const INVALID_PATH_CHARACTERS = new Set([
  "\\",
  ":",
  "?",
  "[",
  "]",
  "{",
  "}",
  "<",
  ">",
  "|",
]);

function hasInvalidPathCharacter(value: string): boolean {
  return [...value].some((character) => INVALID_PATH_CHARACTERS.has(character));
}

function requiredMetadataText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && !hasInvalidMetadataTextControl(text) ? text : null;
}

function requiredMetadataId(value: unknown): string | null {
  const id = requiredMetadataText(value);
  return id && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/u.test(id) ? id : null;
}

/** Canonicalize an untrusted repo-relative path without permitting traversal. */
function normalizeMetadataPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === "/" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[A-Za-z]:/u.test(trimmed) ||
    /^(?:https?:|file:)/iu.test(trimmed) ||
    hasControlCharacter(trimmed) ||
    hasInvalidPathCharacter(trimmed)
  ) {
    return null;
  }
  const cleaned = trimmed
    .replace(/^(?:\.\/)+/u, "")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "");
  const segments = cleaned.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /\*{3,}/u.test(segment) ||
        (segment.includes("**") && segment !== "**") ||
        (segment.includes("*") &&
          segment !== "*" &&
          segment !== "**" &&
          !/^(?:\*[^*]+|[^*]+\*)$/u.test(segment)),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function metadataPathArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const path = normalizeMetadataPath(item);
    if (!path) return null;
    paths.push(path);
  }
  return uniqueSorted(paths);
}

function parseLaneCollision(value: unknown): LaneCollision | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const source = record.source;
  const id = requiredMetadataId(record.id);
  const paths = metadataPathArray(record.paths);
  if (
    (source !== "open-pr" &&
      source !== "active-lane" &&
      source !== "sibling") ||
    !id ||
    !paths
  ) {
    return null;
  }
  const title =
    record.title === undefined ? undefined : requiredMetadataText(record.title);
  const url =
    record.url === undefined ? undefined : requiredMetadataText(record.url);
  if (
    (record.title !== undefined && !title) ||
    (record.url !== undefined && !url) ||
    (url !== undefined &&
      (url === null || !/^https:\/\/github\.com\//iu.test(url)))
  ) {
    return null;
  }
  return {
    source,
    id,
    paths,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
  };
}

export function parseLaneTaskMetadata(
  metadata: Record<string, unknown>,
): LaneTaskMetadata | null {
  const waveId = requiredMetadataId(metadata.waveId);
  const waveGoal = requiredMetadataText(metadata.waveGoal);
  const laneId = requiredMetadataId(metadata.laneId);
  const laneRunId = requiredMetadataId(metadata.laneRunId);
  const laneTitle = requiredMetadataText(metadata.laneTitle);
  const laneScope = metadataPathArray(metadata.laneScope);
  const forbiddenPaths = metadataPathArray(metadata.forbiddenPaths);
  const rawCollisions = metadata.laneCollisions;
  const difficultyTag = metadata.difficultyTag;
  const laneCollisions = Array.isArray(rawCollisions)
    ? rawCollisions.map(parseLaneCollision)
    : null;
  if (
    !waveId ||
    !waveGoal ||
    typeof metadata.waveGoalMet !== "boolean" ||
    !laneId ||
    !laneRunId ||
    !laneTitle ||
    !laneScope ||
    !forbiddenPaths ||
    !laneCollisions ||
    laneCollisions.some((collision) => collision === null) ||
    (difficultyTag !== "simple" &&
      difficultyTag !== "moderate" &&
      difficultyTag !== "hard")
  ) {
    return null;
  }
  return {
    waveId,
    waveGoal,
    waveGoalMet: metadata.waveGoalMet,
    laneId,
    laneRunId,
    laneTitle,
    laneScope,
    forbiddenPaths,
    laneCollisions: laneCollisions as LaneCollision[],
    difficultyTag,
  };
}

export function laneTaskMetadata(
  plan: Pick<LanePlan, "waveId" | "waveGoal">,
  lane: LaneSpec,
): LaneTaskMetadata {
  return {
    waveId: plan.waveId,
    waveGoal: plan.waveGoal,
    waveGoalMet: false,
    laneId: lane.id,
    laneRunId: lane.runId,
    laneTitle: lane.title,
    laneScope: [...lane.scope],
    forbiddenPaths: [...lane.forbiddenPaths],
    laneCollisions: lane.collisions.map((collision) => ({
      ...collision,
      paths: [...collision.paths],
    })),
    difficultyTag: lane.difficultyTag,
  };
}

function normalizePath(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/^[\s'"`([{<]+/, "")
    .replace(/[\s'"`)\]}>.,;:]+$/, "");
  if (!/[/.]/u.test(trimmed)) return undefined;
  return normalizeMetadataPath(trimmed) ?? undefined;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sameRepository(left: string, right: string): boolean {
  try {
    const leftRepo = parseOwnerRepo(left);
    const rightRepo = parseOwnerRepo(right);
    return (
      leftRepo.owner.toLowerCase() === rightRepo.owner.toLowerCase() &&
      leftRepo.repo.toLowerCase() === rightRepo.repo.toLowerCase()
    );
  } catch {
    // error-policy:J3 a malformed stored repository cannot be trusted as a
    // disjoint repo, so retain the collision conservatively.
    return true;
  }
}

export function extractScopePaths(text: string): string[] {
  const matches = text.match(
    /(?:^|[\s(["'`])((?:packages|plugins|src|scripts|docs|tests|test|app|apps|public|server|client|components|lib|services|api|\.\/)[A-Za-z0-9_./*-]*|[A-Za-z0-9_-]+\/[A-Za-z0-9_./*-]+\.[A-Za-z0-9_-]+)/g,
  );
  if (!matches) return [];
  return uniqueSorted(
    matches
      .map((match) => normalizePath(match))
      .filter((path): path is string => path !== undefined),
  );
}

function pathOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes("*") || b.includes("*")) {
    const leftPrefix = a.slice(
      0,
      a.indexOf("*") < 0 ? a.length : a.indexOf("*"),
    );
    const rightPrefix = b.slice(
      0,
      b.indexOf("*") < 0 ? b.length : b.indexOf("*"),
    );
    return (
      leftPrefix.length === 0 ||
      rightPrefix.length === 0 ||
      leftPrefix.startsWith(rightPrefix) ||
      rightPrefix.startsWith(leftPrefix)
    );
  }
  const left = a.endsWith("/") ? a : `${a}/`;
  const right = b.endsWith("/") ? b : `${b}/`;
  return left.startsWith(right) || right.startsWith(left);
}

export function scopeSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((a) => right.some((b) => pathOverlaps(a, b)));
}

function splitTaskText(task: string): string[] {
  return task
    .split(
      /\n+|(?:^|\s)(?:and|then|also)\s+(?=(?:update|fix|add|build|create|refactor|test|document|wire|implement)\b)/i,
    )
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function difficultyFor(
  task: string,
  explicit: string | undefined,
): LaneSpec["difficultyTag"] {
  const tag = explicit?.trim().toLowerCase();
  if (tag === "simple" || tag === "moderate" || tag === "hard") return tag;
  if (tag === "standard") return "moderate";
  if (tag === "complex") return "hard";
  const text = task.toLowerCase();
  if (
    /\b(schema|migration|auth|security|cross-package|architecture)\b/.test(text)
  ) {
    return "hard";
  }
  if (/\b(test|docs?|copy|style|lint)\b/.test(text)) return "simple";
  return "moderate";
}

function lanePrompt(input: {
  waveGoal: string;
  laneGoal: string;
  scopes: string[];
  forbidden: string[];
  collisions: LaneCollision[];
  criteria: string[];
}): string {
  const lines = [
    `Wave goal: ${input.waveGoal}`,
    `Lane objective: ${input.laneGoal}`,
    "",
    "Owned scope (edit only these paths):",
    ...(input.scopes.length > 0
      ? input.scopes.map((path) => `- ${path}`)
      : ["- no safe parallel scope was identified"]),
    "",
    "Forbidden paths:",
    ...input.forbidden.map((path) => `- ${path}`),
  ];
  if (input.collisions.length > 0) {
    lines.push(
      "",
      "Collision context (inspect before editing; do not overwrite this work):",
      ...input.collisions.map(
        (collision) =>
          `- ${collision.source}:${collision.id}: ${collision.paths.join(", ")}${
            collision.url ? ` (${collision.url})` : ""
          }`,
      ),
    );
  }
  lines.push(
    "",
    "Acceptance criteria:",
    ...input.criteria.map((criterion) => `- ${criterion}`),
    "",
    "Execution and evidence contract:",
    "- Follow repository instructions in every directory you touch.",
    "- Do not edit a forbidden or collision-owned path.",
    "- Run the focused tests, typecheck, and lint relevant to this lane.",
    "- Report the exact changed files, verification commands, and outputs.",
    "- Do not push, open a pull request, or mutate remote state.",
  );
  return lines.join("\n");
}

function normalizeExternalCollisions(
  collisions: readonly ExternalLaneCollision[],
): ExternalLaneCollision[] {
  return collisions
    .map((collision) => ({
      ...collision,
      paths: uniqueSorted(
        collision.paths.map((rawPath) => {
          const path = normalizeMetadataPath(rawPath);
          if (!path) {
            throw new ElizaError("Collision source returned an invalid path", {
              code: "LANE_COLLISION_PATH_INVALID",
              context: { source: collision.source, id: collision.id, rawPath },
            });
          }
          return path;
        }),
      ),
    }))
    .filter((collision) => collision.paths.length > 0)
    .sort((a, b) => `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`));
}

function buildLane(input: {
  plannerInput: LanePlannerInput;
  laneGoal: string;
  index: number;
  siblingScopes: readonly string[][];
  externalCollisions: readonly ExternalLaneCollision[];
  scopeOverride?: string[];
  additionalForbiddenPaths?: string[];
}): LaneSpec {
  const scope = uniqueSorted(
    input.scopeOverride ?? extractScopePaths(input.laneGoal),
  );
  const siblingForbidden = input.siblingScopes
    .filter((_, siblingIndex) => siblingIndex !== input.index)
    .flat();
  const forbiddenPaths = uniqueSorted([
    ...standardLaneForbiddenPaths(),
    ...siblingForbidden,
    ...(input.additionalForbiddenPaths ?? []),
  ]);
  const collisions: LaneCollision[] = [
    ...input.externalCollisions
      .filter((collision) => scopeSetsOverlap(scope, collision.paths))
      .map((collision) => ({ ...collision, paths: [...collision.paths] })),
    ...input.siblingScopes.flatMap((siblingScope, siblingIndex) =>
      siblingIndex === input.index
        ? []
        : [
            {
              source: "sibling" as const,
              id: `lane-${siblingIndex + 1}`,
              paths: [...siblingScope],
            },
          ],
    ),
  ];
  const criteria = uniqueSorted([
    `The lane objective is complete: ${input.laneGoal}`,
    ...(scope.length > 0
      ? [`The diff is limited to the owned scope: ${scope.join(", ")}`]
      : []),
    ...staticAcceptanceCriteria(input.laneGoal),
    ...(input.plannerInput.acceptanceCriteria ?? []),
  ]);
  const waveGoal = input.plannerInput.goal ?? input.plannerInput.task;
  const lane: LaneSpec = {
    id: `lane-${input.index + 1}`,
    runId: `${input.plannerInput.waveId ?? "wave"}:lane-${input.index + 1}`,
    title: (input.siblingScopes.length === 1
      ? (input.plannerInput.title ?? input.laneGoal)
      : input.laneGoal
    ).slice(0, 80),
    goal: input.laneGoal,
    scope,
    forbiddenPaths,
    collisions,
    difficultyTag: difficultyFor(
      input.laneGoal,
      input.plannerInput.difficultyTag,
    ),
    acceptanceCriteria: criteria,
    initialPrompt: "",
  };
  lane.initialPrompt = lanePrompt({
    waveGoal,
    laneGoal: lane.goal,
    scopes: lane.scope,
    forbidden: lane.forbiddenPaths,
    collisions: lane.collisions,
    criteria: lane.acceptanceCriteria,
  });
  return lane;
}

export function createDeterministicLanePlan(
  input: LanePlannerInput,
  externalCollisions: readonly ExternalLaneCollision[] = [],
): LanePlan {
  const requestedTasks =
    input.tasks && input.tasks.length > 0
      ? input.tasks
      : splitTaskText(input.task);
  const candidates = requestedTasks
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
  if (candidates.length > MAX_LANES) {
    throw new ElizaError(
      `Lane planner accepts at most ${MAX_LANES} lanes; received ${candidates.length}`,
      {
        code: "LANE_PLANNER_CAP_EXCEEDED",
        context: { requested: candidates.length, max: MAX_LANES },
      },
    );
  }
  const tasks = candidates.length > 0 ? candidates : [input.task];
  const scopeSets = tasks.map(extractScopePaths);
  if (tasks.length > 1) {
    if (scopeSets.some((scope) => scope.length === 0)) {
      throw new ElizaError(
        "Cannot split lanes without explicit non-overlapping scopes",
        { code: "LANE_PLANNER_SCOPE_MISSING" },
      );
    }
    const forbiddenScope = scopeSets
      .flat()
      .find((path) => standardLaneForbiddenReason(path) !== null);
    if (forbiddenScope) {
      throw new ElizaError(
        `Parallel lane scope is forbidden by repository policy: ${forbiddenScope}`,
        {
          code: "LANE_PLANNER_SCOPE_FORBIDDEN",
          context: {
            path: forbiddenScope,
            reason: standardLaneForbiddenReason(forbiddenScope),
          },
        },
      );
    }
    for (let left = 0; left < scopeSets.length; left += 1) {
      for (let right = left + 1; right < scopeSets.length; right += 1) {
        if (scopeSetsOverlap(scopeSets[left], scopeSets[right])) {
          throw new ElizaError("Lane scopes overlap", {
            code: "LANE_PLANNER_SCOPE_OVERLAP",
            context: { left: scopeSets[left], right: scopeSets[right] },
          });
        }
      }
    }
  }
  const normalizedCollisions = normalizeExternalCollisions(externalCollisions);
  return {
    waveId: input.waveId ?? "wave",
    waveGoal: input.goal ?? input.task,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.workdir ? { workdir: input.workdir } : {}),
    lanes: tasks.map((laneGoal, index) =>
      buildLane({
        plannerInput: input,
        laneGoal,
        index,
        siblingScopes: scopeSets,
        externalCollisions: normalizedCollisions,
      }),
    ),
  };
}

function refinementPrompt(plan: LanePlan): string {
  return [
    "Improve lane titles and acceptance criteria without changing lane ids, lane count, scope, forbidden paths, or prompts.",
    'Return JSON only: {"lanes":[{"id":"lane-1","title":"...","acceptanceCriteria":["..."]}]}',
    JSON.stringify(plan),
  ].join("\n\n");
}

function applyRefinement(plan: LanePlan, raw: string): LanePlan {
  const parsed = parseJsonObjectResponse<{ lanes?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.lanes)) {
    throw new ElizaError("Lane refinement did not return a lanes array", {
      code: "LANE_REFINEMENT_INVALID",
    });
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of parsed.lanes) {
    if (!value || typeof value !== "object") {
      throw new ElizaError("Lane refinement returned a non-object lane", {
        code: "LANE_REFINEMENT_INVALID",
      });
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || byId.has(record.id)) {
      throw new ElizaError("Lane refinement returned invalid lane ids", {
        code: "LANE_REFINEMENT_INVALID",
      });
    }
    byId.set(record.id, record);
  }
  if (
    byId.size !== plan.lanes.length ||
    plan.lanes.some((lane) => !byId.has(lane.id))
  ) {
    throw new ElizaError("Lane refinement changed the lane identity set", {
      code: "LANE_REFINEMENT_CONTRACT_CHANGED",
    });
  }
  return {
    ...plan,
    lanes: plan.lanes.map((lane) => {
      const refined = byId.get(lane.id);
      if (!refined) return lane;
      const criteria = stringArray(refined.acceptanceCriteria);
      const title =
        typeof refined.title === "string" && refined.title.trim().length > 0
          ? refined.title.trim().slice(0, 80)
          : lane.title;
      if (!criteria || criteria.length === 0) return { ...lane, title };
      const acceptanceCriteria = uniqueSorted(criteria);
      return {
        ...lane,
        title,
        acceptanceCriteria,
        initialPrompt: lanePrompt({
          waveGoal: plan.waveGoal,
          laneGoal: lane.goal,
          scopes: lane.scope,
          forbidden: lane.forbiddenPaths,
          collisions: lane.collisions,
          criteria: acceptanceCriteria,
        }),
      };
    }),
  };
}

async function requireRuntimeService<T>(
  runtime: IAgentRuntime,
  serviceType: string,
  matches: (service: unknown) => service is T,
): Promise<T> {
  const loaded: unknown = runtime.getService(serviceType);
  if (matches(loaded)) return loaded;
  if (typeof runtime.getServiceLoadPromise === "function") {
    await runtime.getServiceLoadPromise(serviceType);
  }
  const afterLoad: unknown = runtime.getService(serviceType);
  if (matches(afterLoad)) return afterLoad;
  throw new ElizaError(
    `Required orchestrator service is unavailable: ${serviceType}`,
    {
      code: "LANE_PLANNER_SERVICE_UNAVAILABLE",
      context: { serviceType },
    },
  );
}

export class WorkspacePullRequestCollisionSource
  implements LaneCollisionSource
{
  constructor(private readonly runtime: IAgentRuntime) {}

  async listCollisions(
    input: LaneRepositoryContext,
  ): Promise<ExternalLaneCollision[]> {
    const workspace = await requireRuntimeService<CodingWorkspaceService>(
      this.runtime,
      CodingWorkspaceService.serviceType,
      (service): service is CodingWorkspaceService =>
        service instanceof CodingWorkspaceService,
    );
    const pullRequests = await workspace.listOpenPullRequestChangedFiles(input);
    return pullRequests.map((pullRequest) => ({
      source: "open-pr",
      ...pullRequest,
    }));
  }
}

export class WorkspaceLaneRepositoryResolver implements LaneRepositoryResolver {
  constructor(private readonly runtime: IAgentRuntime) {}

  async resolveRepository(input: LaneRepositoryContext): Promise<string> {
    const workspace = await requireRuntimeService<CodingWorkspaceService>(
      this.runtime,
      CodingWorkspaceService.serviceType,
      (service): service is CodingWorkspaceService =>
        service instanceof CodingWorkspaceService,
    );
    return workspace.resolveRepository(input);
  }
}

export class DurableTaskCollisionSource implements LaneCollisionSource {
  constructor(private readonly runtime: IAgentRuntime) {}

  async listCollisions(
    input: LaneRepositoryContext,
  ): Promise<ExternalLaneCollision[]> {
    const taskService = await requireRuntimeService<OrchestratorTaskService>(
      this.runtime,
      OrchestratorTaskService.serviceType,
      (service): service is OrchestratorTaskService =>
        service instanceof OrchestratorTaskService,
    );
    const summaries = await taskService.listTasks({ includeArchived: false });
    const active = summaries.filter(
      (task) =>
        !TERMINAL_TASK_STATUSES.has(task.status) &&
        !input.excludeTaskIds?.includes(task.id),
    );
    const details = await Promise.all(
      active.map((task) => taskService.getTask(task.id)),
    );
    const collisions: ExternalLaneCollision[] = [];
    for (const detail of details) {
      if (!detail) {
        throw new ElizaError(
          "An active task disappeared during collision discovery",
          {
            code: "LANE_COLLISION_TASK_MISSING",
          },
        );
      }
      const metadata = parseLaneTaskMetadata(detail.metadata);
      if (!metadata) {
        const hasLaneMarker = [
          "waveId",
          "laneId",
          "laneRunId",
          "laneScope",
          "laneCollisions",
        ].some((key) => key in detail.metadata);
        if (hasLaneMarker) {
          throw new ElizaError(
            "An active lane has invalid collision metadata",
            {
              code: "LANE_COLLISION_METADATA_INVALID",
              context: { taskId: detail.id },
            },
          );
        }
        continue;
      }
      if (metadata.laneScope.length === 0) continue;
      if (
        input.repo &&
        detail.latestRepo &&
        !sameRepository(detail.latestRepo, input.repo)
      ) {
        continue;
      }
      if (
        !input.repo &&
        input.workdir &&
        detail.latestWorkdir &&
        detail.latestWorkdir !== input.workdir
      ) {
        continue;
      }
      collisions.push({
        source: "active-lane",
        id: detail.id,
        title: detail.title,
        paths: metadata.laneScope,
      });
    }
    return collisions;
  }
}

export class LanePlannerService extends Service {
  static serviceType = LANE_PLANNER_SERVICE_TYPE;
  capabilityDescription =
    "Plans deconflicted coding lanes using durable task and GitHub collision truth";

  private readonly collisionSources: readonly LaneCollisionSource[];
  private readonly repositoryResolver: LaneRepositoryResolver | null;

  constructor(
    runtime: IAgentRuntime,
    options: {
      collisionSources?: readonly LaneCollisionSource[];
      repositoryResolver?: LaneRepositoryResolver | null;
    } = {},
  ) {
    super(runtime);
    this.collisionSources = options.collisionSources ?? [
      new WorkspacePullRequestCollisionSource(runtime),
      new DurableTaskCollisionSource(runtime),
    ];
    this.repositoryResolver =
      options.repositoryResolver === undefined
        ? options.collisionSources === undefined
          ? new WorkspaceLaneRepositoryResolver(runtime)
          : null
        : options.repositoryResolver;
  }

  static async start(runtime: IAgentRuntime): Promise<LanePlannerService> {
    return new LanePlannerService(runtime);
  }

  async stop(): Promise<void> {}

  private async collisionContext(input: LaneRepositoryContext): Promise<{
    context: LaneRepositoryContext;
    collisions: ExternalLaneCollision[];
  }> {
    let context = input;
    if (input.workdir && this.repositoryResolver) {
      const resolvedRepo = await this.repositoryResolver.resolveRepository({
        workdir: input.workdir,
      });
      if (input.repo && !sameRepository(input.repo, resolvedRepo)) {
        throw new ElizaError(
          "Requested repository does not match the resolved execution workdir",
          {
            code: "LANE_REPOSITORY_MISMATCH",
            context: {
              requestedRepo: input.repo,
              resolvedRepo,
              workdir: input.workdir,
            },
          },
        );
      }
      context = { ...input, repo: resolvedRepo };
    }
    const groups = await Promise.all(
      this.collisionSources.map((source) => source.listCollisions(context)),
    );
    return {
      context,
      collisions: normalizeExternalCollisions(groups.flat()),
    };
  }

  private async refine(plan: LanePlan): Promise<LanePlan> {
    if (
      !isEnabledValue(readSetting(this.runtime, LANE_PLANNER_REFINE_SETTING))
    ) {
      return plan;
    }
    try {
      const result = await this.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: refinementPrompt(plan),
        stopSequences: [],
      });
      if (typeof result !== "string") {
        throw new ElizaError("Lane refinement returned a non-string result", {
          code: "LANE_REFINEMENT_INVALID",
        });
      }
      return applyRefinement(plan, result);
    } catch (error) {
      // error-policy:J4 optional model refinement degrades to the complete,
      // deterministic plan; reportError keeps the dependency failure visible.
      this.runtime.reportError("LanePlanner.refine", error, {
        waveId: plan.waveId,
      });
      return plan;
    }
  }

  async plan(input: LanePlannerInput): Promise<LanePlan> {
    const withWaveId = { ...input, waveId: input.waveId ?? randomUUID() };
    const { context, collisions } = await this.collisionContext({
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.workdir ? { workdir: input.workdir } : {}),
      ...(input.excludeTaskIds ? { excludeTaskIds: input.excludeTaskIds } : {}),
    });
    return this.refine(
      createDeterministicLanePlan({ ...withWaveId, ...context }, collisions),
    );
  }

  /**
   * Wave-supervisor refill contract. A verified aggregate goal result is
   * authoritative: once completed lanes prove the wave goal, no replacement is
   * emitted. Otherwise the failed lane keeps its canonical scope while current
   * active scopes and remote collisions constrain the replacement.
   */
  async planReplacement(
    request: WaveRefillRequest,
  ): Promise<WaveReplacementSpec | null> {
    if (request.waveGoalEvaluation?.met === true) return null;
    const terminalMetadata = parseLaneTaskMetadata(
      request.terminalLane.metadata,
    );
    if (!terminalMetadata || terminalMetadata.laneScope.length === 0) {
      throw new ElizaError("Cannot refill a lane with invalid metadata", {
        code: "LANE_REFILL_METADATA_INVALID",
        context: { taskId: request.terminalLane.id },
      });
    }
    const forbiddenScope = terminalMetadata.laneScope.find(
      (path) => standardLaneForbiddenReason(path) !== null,
    );
    if (forbiddenScope) {
      throw new ElizaError("Cannot refill a repository-forbidden lane scope", {
        code: "LANE_REFILL_SCOPE_FORBIDDEN",
        context: {
          taskId: request.terminalLane.id,
          path: forbiddenScope,
          reason: standardLaneForbiddenReason(forbiddenScope),
        },
      });
    }
    const activeScopes = request.activeLanes.flatMap((task) => {
      const metadata = parseLaneTaskMetadata(task.metadata);
      if (!metadata) {
        throw new ElizaError("An active refill sibling has invalid metadata", {
          code: "LANE_REFILL_ACTIVE_METADATA_INVALID",
          context: { taskId: task.id },
        });
      }
      return metadata.laneScope;
    });
    const { context, collisions: currentCollisions } =
      await this.collisionContext({
        ...(request.terminalLane.latestRepo
          ? { repo: request.terminalLane.latestRepo }
          : {}),
        ...(request.terminalLane.latestWorkdir
          ? { workdir: request.terminalLane.latestWorkdir }
          : {}),
        excludeTaskIds: [request.terminalLane.id],
      });
    const suppliedCollisions: ExternalLaneCollision[] = request.collisions.map(
      (collision, index) => ({
        source: "active-lane",
        id: collision.key ?? `wave-collision-${index + 1}`,
        paths: collision.paths,
      }),
    );
    const plannerInput: LanePlannerInput = {
      task: request.terminalLane.goal,
      title: request.terminalLane.title,
      goal: request.waveGoal,
      waveId: request.waveId,
      acceptanceCriteria: request.terminalLane.acceptanceCriteria,
      difficultyTag: terminalMetadata.difficultyTag,
    };
    const lane = buildLane({
      plannerInput,
      laneGoal: request.terminalLane.goal,
      index: 0,
      siblingScopes: [terminalMetadata.laneScope],
      externalCollisions: normalizeExternalCollisions([
        ...currentCollisions,
        ...suppliedCollisions,
      ]),
      scopeOverride: terminalMetadata.laneScope,
      additionalForbiddenPaths: activeScopes,
    });
    lane.id = terminalMetadata.laneId;
    lane.runId = `${request.waveId}:refill:${request.terminalLane.id}:${randomUUID()}`;
    const refined = await this.refine({
      waveId: request.waveId,
      waveGoal: request.waveGoal,
      ...(context.repo ? { repo: context.repo } : {}),
      ...(context.workdir ? { workdir: context.workdir } : {}),
      lanes: [lane],
    });
    const replacement = refined.lanes[0];
    if (!replacement) {
      throw new ElizaError("Lane refinement removed the replacement lane", {
        code: "LANE_REFILL_REPLACEMENT_MISSING",
        context: { taskId: request.terminalLane.id },
      });
    }
    return {
      title: replacement.title,
      goal: replacement.goal,
      initialPrompt: replacement.initialPrompt,
      scope: replacement.scope,
      forbiddenPaths: replacement.forbiddenPaths,
      acceptanceCriteria: replacement.acceptanceCriteria,
      difficultyTag: replacement.difficultyTag,
      metadata: laneTaskMetadata(refined, replacement),
    };
  }
}
