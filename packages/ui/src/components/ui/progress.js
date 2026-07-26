/**
 * Determinate progress bar over Radix `@radix-ui/react-progress`, themed to the
 * kit tokens. Derived from shadcn/ui `progress`
 * (https://ui.shadcn.com/docs/components/progress).
 */
"use client";
import { jsx as _jsx } from "react/jsx-runtime";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../../lib/utils";
function Progress({ className, value, ...props }) {
    return (_jsx(ProgressPrimitive.Root, { "data-slot": "progress", className: cn("relative h-2.5 w-full overflow-hidden rounded-sm border border-border bg-bg-accent", className), ...props, children: _jsx(ProgressPrimitive.Indicator, { "data-slot": "progress-indicator", className: "h-full w-full flex-1 bg-primary transition-all", style: { transform: `translateX(-${100 - (value || 0)}%)` } }) }));
}
export { Progress };
