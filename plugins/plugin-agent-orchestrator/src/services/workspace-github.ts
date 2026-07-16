/**
 * Owns authenticated GitHub operations for coding workspaces. Stateless
 * functions consume the workspace service's shared PAT/OAuth client so issue,
 * pull-request, and collision reads use one credential and transport boundary.
 */

import { createRequire } from "node:module";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  CreateIssueOptions,
  GitHubPatClient as GitHubPatClientInstance,
  IssueComment,
  IssueInfo,
  IssueState,
} from "git-workspace-service";

const { GitHubPatClient, OAuthDeviceFlow } = createRequire(import.meta.url)(
  "git-workspace-service",
) as typeof import("git-workspace-service");

/**
 * Callback for surfacing auth prompts to the user.
 * Returns true only when the prompt was delivered through an immediate
 * user-visible channel. Buffered action callbacks are unsafe here because the
 * device flow blocks until the user sees and completes the prompt.
 */
export type AuthPromptCallback = (prompt: {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
}) => boolean | Promise<boolean>;

/**
 * Context object passed by CodingWorkspaceService into every GitHub function.
 * Lets us keep the extracted functions stateless while still mutating shared state.
 */
export interface GitHubContext {
  runtime: IAgentRuntime;
  githubClient: GitHubPatClientInstance | null;
  setGithubClient: (client: GitHubPatClientInstance) => void;
  githubAuthInProgress: Promise<GitHubPatClientInstance> | null;
  setGithubAuthInProgress: (p: Promise<GitHubPatClientInstance> | null) => void;
  authPromptCallback: AuthPromptCallback | null;
  log: (msg: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────

export function parseOwnerRepo(repo: string): {
  owner: string;
  repo: string;
} {
  const trimmed = repo.trim().replace(/\/+$/, "");
  const https = trimmed.match(
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  const ssh = trimmed.match(
    /^(?:ssh:\/\/)?[^@\s]+@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  const hosted = trimmed.match(
    /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  const shorthand = trimmed.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  const match = https ?? ssh ?? hosted ?? shorthand;
  if (!match) {
    throw new ElizaError(`Cannot parse owner/repo from: ${repo}`, {
      code: "GITHUB_REPOSITORY_INVALID",
      context: { repo },
    });
  }
  return { owner: match[1], repo: match[2] };
}

interface GitHubRequestResponse {
  data: unknown;
}

type GitHubRequest = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<GitHubRequestResponse>;

function requestFromClient(client: GitHubPatClientInstance): GitHubRequest {
  const octokit: unknown = Reflect.get(client, "octokit");
  if (!octokit || typeof octokit !== "object") {
    throw new ElizaError(
      "GitHub client does not expose its authenticated transport",
      {
        code: "GITHUB_TRANSPORT_UNAVAILABLE",
      },
    );
  }
  const request: unknown = Reflect.get(octokit, "request");
  if (typeof request !== "function") {
    throw new ElizaError("GitHub client transport has no request method", {
      code: "GITHUB_TRANSPORT_UNAVAILABLE",
    });
  }
  return async (route, parameters) => {
    const response: unknown = await Reflect.apply(request, octokit, [
      route,
      parameters,
    ]);
    if (!response || typeof response !== "object" || !("data" in response)) {
      throw new ElizaError("GitHub transport returned an invalid response", {
        code: "GITHUB_RESPONSE_INVALID",
        context: { route },
      });
    }
    return { data: Reflect.get(response, "data") };
  };
}

/** Reuse the authenticated transport owned by GitHubPatClient. */
export async function authenticatedGitHubRequest(
  ctx: GitHubContext,
  route: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const client = await ensureGitHubClient(ctx);
  const response = await requestFromClient(client)(route, parameters);
  return response.data;
}

/** Exhaust a GitHub list endpoint without silently truncating at 30/100 rows. */
export async function pagedGitHubRequest(
  ctx: GitHubContext,
  route: string,
  parameters: Record<string, unknown>,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const data = await authenticatedGitHubRequest(ctx, route, {
      ...parameters,
      per_page: 100,
      page,
    });
    if (!Array.isArray(data)) {
      throw new ElizaError(
        "GitHub list endpoint returned a non-array response",
        {
          code: "GITHUB_RESPONSE_INVALID",
          context: { route, page },
        },
      );
    }
    values.push(...data);
    if (data.length < 100) return values;
  }
}

export interface OpenPullRequestChangedFiles {
  id: string;
  number: number;
  title: string;
  url: string;
  paths: string[];
}

function pullRequestIdentity(value: unknown): {
  number: number;
  title: string;
  url: string;
} {
  if (!value || typeof value !== "object") {
    throw new ElizaError("GitHub returned a non-object pull request", {
      code: "GITHUB_RESPONSE_INVALID",
    });
  }
  const number: unknown = Reflect.get(value, "number");
  const title: unknown = Reflect.get(value, "title");
  const url: unknown = Reflect.get(value, "html_url");
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    typeof title !== "string" ||
    typeof url !== "string"
  ) {
    throw new ElizaError(
      "GitHub pull request response is missing identity fields",
      {
        code: "GITHUB_RESPONSE_INVALID",
      },
    );
  }
  return { number, title, url };
}

function changedPaths(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    throw new ElizaError("GitHub returned a non-object changed file", {
      code: "GITHUB_RESPONSE_INVALID",
    });
  }
  const filename: unknown = Reflect.get(value, "filename");
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new ElizaError("GitHub changed-file response has no filename", {
      code: "GITHUB_RESPONSE_INVALID",
    });
  }
  const previousFilename: unknown = Reflect.get(value, "previous_filename");
  if (
    previousFilename !== undefined &&
    (typeof previousFilename !== "string" ||
      previousFilename.trim().length === 0)
  ) {
    throw new ElizaError(
      "GitHub renamed-file response has an invalid previous filename",
      { code: "GITHUB_RESPONSE_INVALID" },
    );
  }
  return [
    filename,
    ...(typeof previousFilename === "string" ? [previousFilename] : []),
  ];
}

/** List every open PR and its complete changed-file set for collision checks. */
export async function listOpenPullRequestChangedFiles(
  ctx: GitHubContext,
  repo: string,
): Promise<OpenPullRequestChangedFiles[]> {
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  const pulls = await pagedGitHubRequest(
    ctx,
    "GET /repos/{owner}/{repo}/pulls",
    {
      owner,
      repo: repoName,
      state: "open",
    },
  );
  const results: OpenPullRequestChangedFiles[] = [];
  // Serial PR file reads avoid GitHub's secondary-rate-limit burst while each
  // individual endpoint still exhausts all of its pages.
  for (const value of pulls) {
    const identity = pullRequestIdentity(value);
    const files = await pagedGitHubRequest(
      ctx,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo: repoName, pull_number: identity.number },
    );
    results.push({
      id: `pr-${identity.number}`,
      number: identity.number,
      title: identity.title,
      url: identity.url,
      paths: [...new Set(files.flatMap(changedPaths))].sort((a, b) =>
        a.localeCompare(b),
      ),
    });
  }
  return results;
}

// ── Auth ───────────────────────────────────────────────────────────

export async function ensureGitHubClient(
  ctx: GitHubContext,
): Promise<GitHubPatClientInstance> {
  // Already have a client
  if (ctx.githubClient) return ctx.githubClient;

  // Auth already in progress (another call triggered it) - wait for it
  if (ctx.githubAuthInProgress) return ctx.githubAuthInProgress;

  // Check for PAT (re-check in case it was set after init)
  const githubToken = ctx.runtime.getSetting("GITHUB_TOKEN") as
    | string
    | undefined;
  if (githubToken) {
    const client = new GitHubPatClient({ token: githubToken });
    ctx.setGithubClient(client);
    ctx.log("GitHubPatClient initialized with PAT (late binding)");
    return client;
  }

  // Try OAuth device flow (explicit user consent, scoped permissions)
  const clientId = ctx.runtime.getSetting("GITHUB_OAUTH_CLIENT_ID") as
    | string
    | undefined;
  if (!clientId) {
    throw new Error(
      "GitHub access required but no credentials are configured. " +
        "Connect GitHub in Settings → Coding Agents (paste a personal access token, " +
        'or "Sign in with GitHub" when a GITHUB_OAUTH_CLIENT_ID is configured). ' +
        "Alternatively set the GITHUB_TOKEN setting for this agent.",
    );
  }

  // Start OAuth - deduplicate concurrent requests
  const authPromise = performOAuthFlow(ctx, clientId);
  ctx.setGithubAuthInProgress(authPromise);
  try {
    const client = await authPromise;
    return client;
  } finally {
    ctx.setGithubAuthInProgress(null);
  }
}

export async function performOAuthFlow(
  ctx: GitHubContext,
  clientId: string,
): Promise<GitHubPatClientInstance> {
  // Read directly from process.env — this is a server-side secret that
  // should not be exposed through the plugin getSetting() allowlist.
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const oauth = new OAuthDeviceFlow({
    clientId,
    clientSecret,
    permissions: {
      repositories: { type: "public" },
      contents: "write",
      issues: "write",
      pullRequests: "write",
      metadata: "read",
    },
    timeout: 300, // 5 minutes
  });

  // Step 1: Request device code
  const deviceCode = await oauth.requestDeviceCode();

  // Step 2: Surface the auth prompt to the user
  const delivered = ctx.authPromptCallback
    ? await ctx.authPromptCallback({
        verificationUri: deviceCode.verificationUri,
        userCode: deviceCode.userCode,
        expiresIn: deviceCode.expiresIn,
      })
    : false;

  if (!delivered) {
    throw new Error(
      "GitHub OAuth device flow requires an immediate chat delivery path before polling. " +
        "Wire an authPromptCallback, connect GitHub in Settings → Coding Agents, " +
        "or set the GITHUB_TOKEN setting.",
    );
  }

  // Step 3: Poll until user completes auth
  const token = await oauth.pollForToken(deviceCode);

  // Step 4: Create client with the obtained token
  const client = new GitHubPatClient({ token: token.accessToken });
  ctx.setGithubClient(client);
  ctx.log("GitHubPatClient initialized via OAuth device flow");
  return client;
}

// ── Issue Management ───────────────────────────────────────────────

export async function createIssue(
  ctx: GitHubContext,
  repo: string,
  options: CreateIssueOptions,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  const issue = await client.createIssue(owner, repoName, options);
  ctx.log(`Created issue #${issue.number}: ${issue.title}`);
  return issue;
}

export async function getIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.getIssue(owner, repoName, issueNumber);
}

export async function listIssues(
  ctx: GitHubContext,
  repo: string,
  options?: {
    state?: IssueState | "all";
    labels?: string[];
    assignee?: string;
  },
): Promise<IssueInfo[]> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.listIssues(owner, repoName, options);
}

export async function updateIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
  options: {
    title?: string;
    body?: string;
    state?: IssueState;
    labels?: string[];
    assignees?: string[];
  },
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.updateIssue(owner, repoName, issueNumber, options);
}

export async function addComment(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<IssueComment> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.addComment(owner, repoName, issueNumber, { body });
}

export async function listComments(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.listComments(owner, repoName, issueNumber);
}

export async function closeIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  const issue = await client.closeIssue(owner, repoName, issueNumber);
  ctx.log(`Closed issue #${issueNumber}`);
  return issue;
}

export async function reopenIssue(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
): Promise<IssueInfo> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  return client.reopenIssue(owner, repoName, issueNumber);
}

export async function addLabels(
  ctx: GitHubContext,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  const client = await ensureGitHubClient(ctx);
  const { owner, repo: repoName } = parseOwnerRepo(repo);
  await client.addLabels(owner, repoName, issueNumber, labels);
}
