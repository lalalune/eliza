import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { useAgentElement } from "./useAgentElement";
export function AgentButton({ agentId, agentLabel, agentRole = "button", agentStatus, agentGroup, agentDescription, children, ...rest }) {
    const label = agentLabel ?? (typeof children === "string" ? children : agentId);
    const { ref, agentProps } = useAgentElement({
        id: agentId,
        role: agentRole,
        label,
        status: agentStatus,
        group: agentGroup,
        description: agentDescription,
    });
    return (_jsx(Button, { ref: ref, ...agentProps, ...rest, children: children }));
}
export function AgentInput({ agentId, agentLabel, agentRole = "text-input", agentStatus, agentGroup, agentDescription, ...rest }) {
    const { ref, agentProps } = useAgentElement({
        id: agentId,
        role: agentRole,
        label: agentLabel,
        status: agentStatus,
        group: agentGroup,
        description: agentDescription,
    });
    return _jsx(Input, { ref: ref, "aria-label": agentLabel, ...agentProps, ...rest });
}
const TONE_CLASSES = {
    neutral: "bg-bg-muted text-text border-border",
    accent: "bg-accent-subtle text-accent border-accent-muted",
    success: "bg-status-success/15 text-status-success border-status-success/30",
    warning: "bg-status-warning/15 text-status-warning border-status-warning/30",
    danger: "bg-status-danger/15 text-status-danger border-status-danger/30",
};
/**
 * IconTag — a compact, graphic-first chip (icon + label) used to replace bare
 * text tags. The rounded-full pill + `data-status` make it register as a visual
 * indicator in the view audit.
 */
export function IconTag({ icon: Icon, label, tone = "neutral", status, className, title, }) {
    return (_jsxs("span", { "data-status": status ?? tone, "data-state": status ?? tone, title: title, className: cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", TONE_CLASSES[tone], className), children: [Icon ? _jsx(Icon, { className: "h-3 w-3", "aria-hidden": true }) : null, label] }));
}
