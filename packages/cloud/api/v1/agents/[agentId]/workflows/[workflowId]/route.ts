/** Public-SDK alias for canonical single-workflow read and mutations. */

import { type Context, Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  handleWorkflowProxyOptions,
  handleWorkflowProxyRequest,
} from "../../../../eliza/agents/[agentId]/workflows/_shared";

const app = new Hono<AppEnv>();

app.options("/", (c) => handleWorkflowProxyOptions(c.req.header("origin")));
const proxyWorkflow = (c: Context<AppEnv>) =>
  handleWorkflowProxyRequest(
    c.req.raw,
    c.req.param("agentId"),
    c.req.param("workflowId"),
    c,
  );
app.get("/", proxyWorkflow);
app.put("/", proxyWorkflow);
app.delete("/", proxyWorkflow);

export default app;
