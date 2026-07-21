/**
 * Public-SDK alias for workflow list and create operations. Delegating to the
 * canonical Eliza-agent boundary keeps ownership principals, tier capability
 * gates, paid-compute wake checks, CORS, and timeout semantics identical.
 */

import { type Context, Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import {
  handleWorkflowProxyOptions,
  handleWorkflowProxyRequest,
} from "../../../eliza/agents/[agentId]/workflows/_shared";

const app = new Hono<AppEnv>();

app.options("/", (c) => handleWorkflowProxyOptions(c.req.header("origin")));
const proxyCollection = (c: Context<AppEnv>) =>
  handleWorkflowProxyRequest(c.req.raw, c.req.param("agentId"), "", c);
app.get("/", proxyCollection);
app.post("/", proxyCollection);

export default app;
