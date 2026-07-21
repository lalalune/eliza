/** Public-SDK alias for canonical workflow execution lookup. */

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  handleWorkflowProxyOptions,
  handleWorkflowProxyRequest,
} from "../../../../../eliza/agents/[agentId]/workflows/_shared";

const app = new Hono<AppEnv>();

app.options("/", (c) => handleWorkflowProxyOptions(c.req.header("origin")));
app.get("/", (c) => {
  const executionId = c.req.param("executionId");
  return handleWorkflowProxyRequest(
    c.req.raw,
    c.req.param("agentId"),
    executionId === undefined ? undefined : `executions/${executionId}`,
    c,
  );
});

export default app;
