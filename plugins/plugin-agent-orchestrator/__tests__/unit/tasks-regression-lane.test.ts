/**
 * Composes the behavioral matrix for changes to the monolithic TASKS action.
 * The changed-file coverage lane runs only tests present in a pull-request
 * diff, so this file keeps planner lifecycle changes attached to every legacy
 * operation until the action is decomposed into independently covered modules.
 */

import { beforeEach } from "vitest";
import { state } from "../../src/test-utils/action-test-utils.ts";
import "./archive-reopen-lifecycle.test.ts";
import "./cancel-task.test.ts";
import "./control-resume-clears-paused.test.ts";
import "./create-task-attaches-sessions.test.ts";
import "./create-task-emits-widget-block.test.ts";
import "./create-task.test.ts";
import "./distinct-task-rooms.test.ts";
import "./list-agents.test.ts";
import "./provision-workspace.test.ts";
import "./send-to-agent.test.ts";
import "./spawn-agent.test.ts";
import "./stop-agent.test.ts";
import "./task-control-structural.test.ts";
import "./task-history.test.ts";
import "./tasks-action-aliases.test.ts";
import "./tasks-create-validator-lifecycle.test.ts";

beforeEach(() => {
  // These suites normally run in separate files; composition intentionally
  // preserves that isolation for their shared action-state fixture.
  delete state.codingSession;
  delete state.codingSessions;
});
