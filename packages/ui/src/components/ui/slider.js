import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Range slider over Radix `@radix-ui/react-slider`, themed to the kit tokens.
 * Derived from shadcn/ui `slider` (https://ui.shadcn.com/docs/components/slider).
 */
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as React from "react";
import { cn } from "../../lib/utils";
const Slider = React.forwardRef(({ className, ...props }, ref) => (_jsxs(SliderPrimitive.Root, { ref: ref, className: cn("relative flex w-full touch-none select-none items-center", className), ...props, children: [_jsx(SliderPrimitive.Track, { className: "relative h-2 w-full grow overflow-hidden rounded-sm bg-input", children: _jsx(SliderPrimitive.Range, { className: "absolute h-full bg-primary" }) }), _jsx(SliderPrimitive.Thumb, { className: "block h-5 w-5 rounded-sm border-2 border-primary bg-bg  transition-colors     disabled:pointer-events-none disabled:opacity-50" })] })));
Slider.displayName = SliderPrimitive.Root.displayName;
export { Slider };
