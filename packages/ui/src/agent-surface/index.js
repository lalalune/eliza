/**
 * agent-surface — the unified layer that makes every view fully controllable by
 * the agent: addressable elements, focus awareness, programmatic fill/click,
 * visual indicators, and a capability bridge to the floating-pill chat/voice.
 */
export { AgentElementOverlay } from "./AgentElementOverlay";
export { AgentSurfaceProvider, } from "./AgentSurfaceContext";
export { AgentSurfaceContext, useAgentSurface, } from "./AgentSurfaceContext.hooks";
export { handleAgentSurfaceCapability, isAgentSurfaceCapability, } from "./capabilities";
export { AgentButton, AgentInput, IconTag, } from "./components";
export { AgentSurfaceElementReporter } from "./element-reporter";
export { useAgentSurfaceElementReporter } from "./element-reporter.hooks";
export { getOrCreateViewRegistry, getViewRegistry, removeViewRegistry, setNativeFieldValue, ViewAgentRegistry, } from "./registry";
export { isSensitiveAgentElement, SENSITIVE_AGENT_ELEMENT_REASON, } from "./sensitive";
export { AGENT_SURFACE_CAPABILITY_IDS, CLICKABLE_ROLES, FILLABLE_ROLES, } from "./types";
export { useAgentElement, } from "./useAgentElement";
