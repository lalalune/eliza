/**
 * HTTP-boundary tests for GitHub issue and pull-request functions.
 * A REAL local node:http server implements the GitHub REST endpoints and a
 * REAL `GitHubPatClient` (Octokit under the hood) is pointed at it via its
 * `baseUrl` option, then injected through the production `GitHubContext`
 * client slot — so the entire request path (auth header, method, route,
 * payload serialization, response mapping) is genuinely exercised; only the
 * host on the other end of the socket is local. Error legs assert non-2xx
 * responses surface as thrown errors, never as fabricated results.
 */
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { IAgentRuntime } from "@elizaos/core";
import type { GitHubPatClient as GitHubPatClientInstance } from "git-workspace-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addComment,
  addLabels,
  closeIssue,
  createIssue,
  ensureGitHubClient,
  type GitHubContext,
  listIssues,
  listOpenPullRequestChangedFiles,
  parseOwnerRepo,
  updateIssue,
} from "../services/workspace-github.ts";
import { CodingWorkspaceService } from "../services/workspace-service.ts";

const { GitHubPatClient } = createRequire(import.meta.url)(
  "git-workspace-service",
) as typeof import("git-workspace-service");

interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

/** Minimal GitHub REST stand-in. Each handler records the request and replies
 * with a canonical GitHub issue payload so the client's field mapping runs. */
class FakeGitHub {
  server: Server | undefined;
  baseUrl = "";
  requests: RecordedRequest[] = [];
  /** When set, the next request gets this failure instead of a 2xx. */
  failNext: { status: number; message: string } | null = null;

  private issueJson(overrides: Record<string, unknown> = {}) {
    return {
      number: 7,
      html_url: "http://local/acme/widgets/issues/7",
      state: "open",
      title: "Broken widget",
      body: "It broke",
      labels: [{ name: "bug" }],
      assignees: [{ login: "octocat" }],
      created_at: "2026-07-01T00:00:00Z",
      closed_at: null,
      ...overrides,
    };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        const path = req.url ?? "";
        this.requests.push({
          method: req.method ?? "",
          path,
          auth: req.headers.authorization,
          body,
        });
        if (this.failNext) {
          const { status, message } = this.failNext;
          this.failNext = null;
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && /\/pulls\?/.test(path)) {
          res.end(
            JSON.stringify([
              {
                number: 17,
                title: "Active refactor",
                html_url: "http://local/acme/widgets/pull/17",
              },
            ]),
          );
          return;
        }
        if (req.method === "GET" && /\/pulls\/17\/files\?/.test(path)) {
          res.end(
            JSON.stringify([
              {
                filename: "src/runtime.ts",
                previous_filename: "src/legacy-runtime.ts",
              },
              { filename: "src/runtime.test.ts" },
            ]),
          );
          return;
        }
        if (
          req.method === "GET" &&
          /\/issues\/7\/comments(?:\?|$)/.test(path)
        ) {
          res.end(
            JSON.stringify([
              {
                id: 999,
                body: "on it",
                user: { login: "octocat" },
                created_at: "2026-07-01T00:00:00Z",
                html_url: "http://local/comment/999",
              },
            ]),
          );
          return;
        }
        if (req.method === "GET" && /\/issues\/7(?:\?|$)/.test(path)) {
          res.end(JSON.stringify(this.issueJson()));
          return;
        }
        if (req.method === "GET" && /\/issues(\?|$)/.test(path)) {
          res.end(
            JSON.stringify([
              this.issueJson(),
              // A PR masquerading in the issues list — the client must filter it.
              this.issueJson({ number: 8, pull_request: { url: "x" } }),
            ]),
          );
          return;
        }
        if (req.method === "POST" && /\/issues\/\d+\/comments$/.test(path)) {
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              id: 999,
              body: (body as { body?: string })?.body ?? "",
              user: { login: "octocat" },
              created_at: "2026-07-01T00:00:00Z",
              html_url: "http://local/comment/999",
            }),
          );
          return;
        }
        if (req.method === "POST" && /\/issues\/\d+\/labels$/.test(path)) {
          res.end(JSON.stringify([{ name: "triage" }]));
          return;
        }
        if (req.method === "POST" && /\/issues$/.test(path)) {
          res.statusCode = 201;
          res.end(
            JSON.stringify(
              this.issueJson({
                title: (body as { title?: string })?.title,
                body: (body as { body?: string })?.body ?? "",
              }),
            ),
          );
          return;
        }
        if (req.method === "PATCH" && /\/issues\/\d+$/.test(path)) {
          res.end(
            JSON.stringify(
              this.issueJson({
                state: (body as { state?: string })?.state ?? "open",
                title: (body as { title?: string })?.title ?? "Broken widget",
              }),
            ),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Not Found" }));
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("fake GitHub server failed to bind");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  lastRequest(): RecordedRequest {
    const last = this.requests.at(-1);
    if (!last) throw new Error("no request recorded");
    return last;
  }
}

function makeCtx(client: GitHubPatClientInstance | null): GitHubContext {
  const state = {
    client,
    inProgress: null as GitHubContext["githubAuthInProgress"],
  };
  return {
    runtime: {
      getSetting: () => undefined,
    } as unknown as IAgentRuntime,
    get githubClient() {
      return state.client;
    },
    setGithubClient: (c) => {
      state.client = c;
    },
    get githubAuthInProgress() {
      return state.inProgress;
    },
    setGithubAuthInProgress: (p) => {
      state.inProgress = p;
    },
    authPromptCallback: null,
    log: () => {},
  };
}

function makeWorkspaceService(
  client: GitHubPatClientInstance,
): CodingWorkspaceService {
  const service = new CodingWorkspaceService({
    getSetting: () => undefined,
    reportError: () => undefined,
  } as unknown as IAgentRuntime);
  Reflect.set(service, "githubClient", client);
  return service;
}

describe("parseOwnerRepo", () => {
  it("parses owner/repo shorthand and full GitHub URLs", () => {
    expect(parseOwnerRepo("acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseOwnerRepo("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
    expect(parseOwnerRepo("git@github.com:acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("throws a typed error on unparseable input", () => {
    expect(() => parseOwnerRepo("not-a-repo")).toThrow(
      /Cannot parse owner\/repo/,
    );
  });
});

describe("ensureGitHubClient", () => {
  it("fails loudly when no client, token, or OAuth client id is configured", async () => {
    await expect(ensureGitHubClient(makeCtx(null))).rejects.toThrow(
      /GitHub access required but no credentials are configured/,
    );
  });

  it("builds a PAT client late when GITHUB_TOKEN appears in settings", async () => {
    const ctx = makeCtx(null);
    (
      ctx.runtime as { getSetting: (k: string) => string | undefined }
    ).getSetting = (k: string) =>
      k === "GITHUB_TOKEN" ? "ghp_test" : undefined;
    const client = await ensureGitHubClient(ctx);
    expect(client).toBeInstanceOf(GitHubPatClient);
    // The context caches the client for subsequent calls.
    expect(await ensureGitHubClient(ctx)).toBe(client);
  });
});

describe("issue functions over a real local GitHub API server", () => {
  const github = new FakeGitHub();
  let ctx: GitHubContext;
  let service: CodingWorkspaceService;

  beforeAll(async () => {
    await github.start();
    const client = new GitHubPatClient({
      token: "ghp_local",
      baseUrl: github.baseUrl,
    });
    ctx = makeCtx(client);
    service = makeWorkspaceService(client);
  });
  afterAll(async () => {
    await github.stop();
  });

  it("createIssue POSTs the exact payload with the PAT and maps the response", async () => {
    const issue = await createIssue(ctx, "acme/widgets", {
      title: "Broken widget",
      body: "It broke",
      labels: ["bug"],
    });
    const req = github.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/acme/widgets/issues");
    expect(req.auth).toBe("token ghp_local");
    expect(req.body).toMatchObject({
      title: "Broken widget",
      body: "It broke",
      labels: ["bug"],
    });
    expect(issue.number).toBe(7);
    expect(issue.title).toBe("Broken widget");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.assignees).toEqual(["octocat"]);
  });

  it("lists open PR changed files through the authenticated client transport", async () => {
    await expect(
      listOpenPullRequestChangedFiles(ctx, "acme/widgets"),
    ).resolves.toEqual([
      {
        id: "pr-17",
        number: 17,
        title: "Active refactor",
        url: "http://local/acme/widgets/pull/17",
        paths: [
          "src/legacy-runtime.ts",
          "src/runtime.test.ts",
          "src/runtime.ts",
        ],
      },
    ]);
    expect(github.requests.at(-2)?.path).toContain(
      "/repos/acme/widgets/pulls?state=open&per_page=100&page=1",
    );
    expect(github.lastRequest().path).toContain(
      "/repos/acme/widgets/pulls/17/files?per_page=100&page=1",
    );
    expect(github.lastRequest().auth).toBe("token ghp_local");
  });

  it("coordinates GitHub issue and collision operations through the workspace service", async () => {
    service.setAuthPromptCallback(async () => true);

    await expect(
      service.createIssue("acme/widgets", {
        title: "Service-created widget",
        body: "Created through the coordinator",
      }),
    ).resolves.toMatchObject({ number: 7 });
    await expect(service.getIssue("acme/widgets", 7)).resolves.toMatchObject({
      number: 7,
      state: "open",
    });
    await expect(
      service.listIssues("acme/widgets", { state: "open" }),
    ).resolves.toHaveLength(1);
    await expect(
      service.listOpenPullRequestChangedFiles({ repo: " acme/widgets " }),
    ).resolves.toEqual([
      expect.objectContaining({
        number: 17,
        paths: [
          "src/legacy-runtime.ts",
          "src/runtime.test.ts",
          "src/runtime.ts",
        ],
      }),
    ]);
    await expect(
      service.updateIssue("acme/widgets", 7, { title: "Coordinated widget" }),
    ).resolves.toMatchObject({ title: "Coordinated widget" });
    await expect(
      service.addComment("acme/widgets", 7, "on it"),
    ).resolves.toMatchObject({ body: "on it" });
    await expect(service.listComments("acme/widgets", 7)).resolves.toHaveLength(
      1,
    );
    await expect(service.closeIssue("acme/widgets", 7)).resolves.toMatchObject({
      state: "closed",
    });
    await expect(service.reopenIssue("acme/widgets", 7)).resolves.toMatchObject(
      { state: "open" },
    );
    await expect(
      service.addLabels("acme/widgets", 7, ["triage"]),
    ).resolves.toBeUndefined();
  });

  it("updateIssue PATCHes the issue with only the provided fields", async () => {
    const issue = await updateIssue(ctx, "acme/widgets", 7, {
      title: "Renamed widget",
    });
    const req = github.lastRequest();
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/repos/acme/widgets/issues/7");
    expect(req.body).toMatchObject({ title: "Renamed widget" });
    expect(issue.title).toBe("Renamed widget");
  });

  it("closeIssue PATCHes state=closed and returns the closed issue", async () => {
    const issue = await closeIssue(ctx, "acme/widgets", 7);
    const req = github.lastRequest();
    expect(req.method).toBe("PATCH");
    expect(req.path).toBe("/repos/acme/widgets/issues/7");
    expect(req.body).toMatchObject({ state: "closed" });
    expect(issue.state).toBe("closed");
  });

  it("addLabels POSTs the label list to the labels endpoint", async () => {
    await addLabels(ctx, "acme/widgets", 7, ["triage", "p1"]);
    const req = github.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/acme/widgets/issues/7/labels");
    expect(req.body).toMatchObject({ labels: ["triage", "p1"] });
  });

  it("addComment POSTs the comment body", async () => {
    await addComment(ctx, "acme/widgets", 7, "on it");
    const req = github.lastRequest();
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/acme/widgets/issues/7/comments");
    expect(req.body).toMatchObject({ body: "on it" });
  });

  it("listIssues passes state/label filters and drops pull requests from the result", async () => {
    const issues = await listIssues(ctx, "acme/widgets", {
      state: "open",
      labels: ["bug"],
    });
    const req = github.lastRequest();
    expect(req.method).toBe("GET");
    expect(req.path).toContain("/repos/acme/widgets/issues");
    expect(req.path).toContain("state=open");
    expect(req.path).toContain("labels=bug");
    // The server returned an issue AND a pull_request row; only the issue maps.
    expect(issues.map((i) => i.number)).toEqual([7]);
  });

  it("a 422 from the API surfaces as a thrown error, not a fabricated issue", async () => {
    github.failNext = { status: 422, message: "Validation Failed" };
    await expect(
      createIssue(ctx, "acme/widgets", { title: "", body: "" }),
    ).rejects.toThrow(/Validation Failed|422/);
  });

  it("a 404 from the API surfaces on update instead of returning a default", async () => {
    github.failNext = { status: 404, message: "Not Found" };
    await expect(
      updateIssue(ctx, "acme/widgets", 999, { title: "x" }),
    ).rejects.toThrow(/Not Found|404/);
  });
});
