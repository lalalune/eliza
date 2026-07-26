/**
 * Verifies CodingWorkspaceService registers the GitHub PR provider required by
 * git-workspace-service finalization. The test stays at the credential boundary:
 * no live GitHub calls, no spawned child agents, and no credential env relay.
 */
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CredentialService as CredentialServiceInstance,
  GitCredential,
  GitProviderAdapter,
  PullRequestInfo,
} from "git-workspace-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubPatProvider } from "../../src/services/workspace-github.js";
import { CodingWorkspaceService } from "../../src/services/workspace-service.js";
import { runtimeWith } from "../../src/test-utils/action-test-utils.js";

const { CredentialService, MemoryTokenStore } = createRequire(import.meta.url)(
  "git-workspace-service",
) as typeof import("git-workspace-service");

const roots: string[] = [];
const originalGitHubToken = process.env.GITHUB_TOKEN;

function tempRoot(): string {
  const root = join(
    tmpdir(),
    `workspace-github-provider-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  roots.push(root);
  return root;
}

function runtimeStub(baseDir: string): ReturnType<typeof runtimeWith> {
  const runtime = runtimeWith();
  runtime.getSetting = vi.fn((key: string) =>
    key === "ELIZA_WORKSPACE_DIR" ? baseDir : undefined,
  );
  return runtime;
}

function credentialService(): CredentialServiceInstance {
  return new CredentialService({ tokenStore: new MemoryTokenStore() });
}

const workspaceCredential: GitCredential = {
  id: "grant-1",
  type: "pat",
  token: "workspace-token",
  repo: "https://github.com/elizaOS/eliza.git",
  permissions: ["contents:read", "contents:write", "pull_requests:write"],
  expiresAt: new Date(Date.now() + 60_000),
  provider: "github",
};

afterEach(() => {
  vi.restoreAllMocks();
  if (originalGitHubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGitHubToken;
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("CodingWorkspaceService GitHub provider registration", () => {
  it("registers the GitHub provider missing from a bare CredentialService", async () => {
    expect(credentialService().getProvider("github")).toBeUndefined();

    const registerProvider = vi.spyOn(
      CredentialService.prototype,
      "registerProvider",
    );
    const service = await CodingWorkspaceService.start(runtimeStub(tempRoot()));
    try {
      const githubProvider = registerProvider.mock.calls
        .map(([provider]) => provider)
        .find((provider): provider is GitProviderAdapter => {
          return provider.name === "github";
        });

      expect(githubProvider).toBeDefined();
    } finally {
      await service.stop();
    }
  });

  it("creates pull requests with the workspace credential token", async () => {
    process.env.GITHUB_TOKEN = "ambient-token";
    const createPullRequest = vi.fn(async (): Promise<PullRequestInfo> => {
      return {
        number: 12,
        url: "https://github.com/elizaOS/eliza/pull/12",
        state: "open",
        sourceBranch: "fix/native-pr",
        targetBranch: "develop",
        title: "fix: native PR",
        executionId: "",
        createdAt: new Date("2026-07-18T00:00:00.000Z"),
      };
    });
    const tokens: string[] = [];
    const provider = createGitHubPatProvider({
      createClient: (token) => {
        tokens.push(token);
        return {
          createPullRequest,
        };
      },
    });

    const result = await provider.createPullRequest({
      repo: "https://github.com/elizaOS/eliza.git",
      sourceBranch: "fix/native-pr",
      targetBranch: "develop",
      title: "fix: native PR",
      body: "Uses the workspace credential.",
      draft: true,
      labels: ["bug"],
      reviewers: ["reviewer"],
      credential: workspaceCredential,
    });

    expect(tokens).toEqual(["workspace-token"]);
    expect(createPullRequest).toHaveBeenCalledWith("elizaOS", "eliza", {
      title: "fix: native PR",
      body: "Uses the workspace credential.",
      head: "fix/native-pr",
      base: "develop",
      draft: true,
      labels: ["bug"],
      reviewers: ["reviewer"],
    });
    expect(result.number).toBe(12);
  });

  it("uses an act-time token resolver and fails closed when it is removed", async () => {
    let currentToken: string | undefined = "rotated-token";
    const tokens: string[] = [];
    const provider = createGitHubPatProvider({
      resolveToken: () => currentToken,
      createClient: (token) => {
        tokens.push(token);
        return {
          createPullRequest: vi.fn(
            async (): Promise<PullRequestInfo> => ({
              number: 13,
              url: "https://github.com/elizaOS/eliza/pull/13",
              state: "open",
              sourceBranch: "fix/rotation",
              targetBranch: "develop",
              title: "fix: rotation",
              executionId: "",
              createdAt: new Date("2026-07-18T00:00:00.000Z"),
            }),
          ),
        };
      },
    });
    const request = {
      repo: "git@github.com:elizaOS/eliza.git",
      sourceBranch: "fix/rotation",
      targetBranch: "develop",
      title: "fix: rotation",
      body: "Uses the current host credential.",
      credential: workspaceCredential,
    };

    await expect(provider.createPullRequest(request)).resolves.toMatchObject({
      number: 13,
    });
    expect(tokens).toEqual(["rotated-token"]);

    currentToken = undefined;
    await expect(provider.createPullRequest(request)).rejects.toMatchObject({
      code: "GITHUB_WORKSPACE_CREDENTIAL_INVALID",
    });
    expect(tokens).toEqual(["rotated-token"]);
  });

  it("rejects cross-repository and under-scoped credentials", async () => {
    const createClient = vi.fn();
    const provider = createGitHubPatProvider({ createClient });

    await expect(
      provider.createPullRequest({
        repo: "elizaOS/other",
        sourceBranch: "fix/scope",
        targetBranch: "develop",
        title: "fix: scope",
        body: "Must not cross repositories.",
        credential: workspaceCredential,
      }),
    ).rejects.toMatchObject({
      code: "GITHUB_WORKSPACE_CREDENTIAL_INVALID",
    });
    await expect(
      provider.createPullRequest({
        repo: workspaceCredential.repo,
        sourceBranch: "fix/scope",
        targetBranch: "develop",
        title: "fix: scope",
        body: "Must require PR write permission.",
        credential: {
          ...workspaceCredential,
          permissions: ["contents:read"],
        },
      }),
    ).rejects.toMatchObject({
      code: "GITHUB_WORKSPACE_CREDENTIAL_INVALID",
    });
    await expect(
      provider.createPullRequest({
        repo: workspaceCredential.repo,
        sourceBranch: "fix/scope",
        targetBranch: "develop",
        title: "fix: scope",
        body: "Must reject expired grants.",
        credential: {
          ...workspaceCredential,
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        },
      }),
    ).rejects.toMatchObject({
      code: "GITHUB_WORKSPACE_CREDENTIAL_INVALID",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("distinguishes a missing branch from GitHub API failures", async () => {
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    const unauthorized = Object.assign(new Error("unauthorized"), {
      status: 401,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(unauthorized);
    const provider = createGitHubPatProvider({
      createRequest: () => request,
    });

    await expect(
      provider.branchExists(
        "ssh://git@github.com/elizaOS/eliza.git",
        "missing",
        workspaceCredential,
      ),
    ).resolves.toBe(false);
    await expect(
      provider.branchExists(
        "github:elizaOS/eliza",
        "private",
        workspaceCredential,
      ),
    ).rejects.toBe(unauthorized);
  });
});
