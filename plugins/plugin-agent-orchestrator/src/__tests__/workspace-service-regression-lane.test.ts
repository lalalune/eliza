/**
 * Composes the git/workspace behavioral matrix for changes to the monolithic
 * CodingWorkspaceService. The suites use real temporary repositories and the
 * package's authenticated GitHub boundary while keeping network transport at
 * the local test server.
 */

import { vi } from "vitest";
import "../../__tests__/unit/git-remote-safety.test.ts";
import "../../__tests__/unit/provision-workspace-injection.test.ts";
import "../../__tests__/unit/provision-workspace.test.ts";
import "./submit-workspace-action.test.ts";
import "./workspace-git-ops.test.ts";
import "./workspace-github-issues.test.ts";
import "./workspace-registry.test.ts";

// A direct Vitest import keeps the changed-test classifier on the right runner;
// the composed real-git matrix also needs headroom on resource-shared CI hosts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
