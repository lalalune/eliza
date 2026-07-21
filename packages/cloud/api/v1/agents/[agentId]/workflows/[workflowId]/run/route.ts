/** Public-SDK alias for canonical Smithers workflow execution. */

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  handleWorkflowProxyOptions,
  handleWorkflowProxyRequest,
} from "../../../../../eliza/agents/[agentId]/workflows/_shared";

const app = new Hono<AppEnv>();

app.options("/", (c) => handleWorkflowProxyOptions(c.req.header("origin")));
app.post("/", (c) => {
  const workflowId = c.req.param("workflowId");
  return handleWorkflowProxyRequest(
    c.req.raw,
    c.req.param("agentId"),
    workflowId === undefined ? undefined : `${workflowId}/run`,
    c,
  );
});

export default app;
