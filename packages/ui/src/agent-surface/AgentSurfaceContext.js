import { jsx as _jsx } from "react/jsx-runtime";
/**
 * AgentSurfaceProvider — supplies the per-view ViewAgentRegistry to descendant
 * elements via React context. Mounted by DynamicViewLoader around every view so
 * any view that calls `useAgentElement` is automatically agent-controllable.
 *
 * The context object and useAgentSurface hook live in
 * ./AgentSurfaceContext.hooks so this file can export only the provider
 * component (React Fast Refresh-compatible).
 */
import { useEffect, useRef } from "react";
import { AgentSurfaceContext, } from "./AgentSurfaceContext.hooks";
import { getOrCreateViewRegistry, removeViewRegistry } from "./registry";
export function AgentSurfaceProvider({ viewId, viewType = "gui", children, }) {
    // The registry instance is owned for the lifetime of this provider.
    const valueRef = useRef(null);
    if (!valueRef.current ||
        valueRef.current.viewId !== viewId ||
        valueRef.current.viewType !== viewType) {
        valueRef.current = {
            registry: getOrCreateViewRegistry(viewId, viewType),
            viewId,
            viewType,
        };
    }
    useEffect(() => {
        // Re-assert the module-map entry on mount (it may have been created above
        // during render) and tear it down on unmount.
        getOrCreateViewRegistry(viewId, viewType);
        return () => removeViewRegistry(viewId, viewType);
    }, [viewId, viewType]);
    return (_jsx(AgentSurfaceContext.Provider, { value: valueRef.current, children: children }));
}
