/**
 * Scheduling plugin registration hosts the generic scheduled-task runner,
 * routes, default-pack seeding, and fallback deps on every platform.
 *
 * Hosts inject production deps and domain packs via the runner deps and default
 * pack registries; the built-in fallback pack only seeds when no host owns the
 * runner. Each runtime keeps one runner service, one injected deps set, and one
 * scheduled-task REST route.
 */
import type { Plugin } from "@elizaos/core";
import { buildSchedulingRoutes } from "./routes/plugin-routes.js";
import { schedulingDbSchema } from "./scheduled-task/db-schema.js";
import { ScheduledTaskRunnerService } from "./scheduled-task/runner-service.js";
import { ScheduledTaskSeedService } from "./scheduled-task/seed-service.js";

export const schedulingPlugin: Plugin = {
  name: "@elizaos/plugin-scheduling",
  description:
    "Scheduling spine: the always-loaded ScheduledTask runtime primitive — runner host, REST surface, durable store, and default-pack seed registry. Owner/channel deps are injected by a host plugin; built-in defaults run when no host is present.",
  dependencies: ["@elizaos/plugin-sql"],
  schema: schedulingDbSchema,
  services: [ScheduledTaskRunnerService, ScheduledTaskSeedService],
  routes: buildSchedulingRoutes(),
  views: [
    {
      id: "lifeops-live-test",
      label: "LifeOps Live Test",
      description:
        "Connect your model and accounts, then run a real LifeOps validation and watch it fire.",
      icon: "FlaskConical",
      path: "/lifeops-live-test",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "LifeOpsLiveTestView",
      tags: ["lifeops", "scheduling", "test", "hitl"],
      // Developer/QA validation surface, not a user destination: gate it behind
      // Developer Mode and keep it off the launcher grid, the view manager, and
      // desktop tabs. The route stays reachable for the live-test workflow.
      developerOnly: true,
      visibleInManager: false,
      desktopTabEnabled: false,
    },
  ],
};
