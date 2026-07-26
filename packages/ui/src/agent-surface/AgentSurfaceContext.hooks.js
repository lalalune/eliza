/**
 * AgentSurface context object + useAgentSurface hook. Kept out of
 * AgentSurfaceContext.tsx so that file exports only the AgentSurfaceProvider
 * component (React Fast Refresh-compatible).
 */
import { createContext, useContext } from "react";
export const AgentSurfaceContext = createContext(null);
/** Returns the active view's registry, or null when rendered outside a view. */
export function useAgentSurface() {
    return useContext(AgentSurfaceContext);
}
