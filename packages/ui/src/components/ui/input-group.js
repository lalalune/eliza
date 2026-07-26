import { jsx as _jsx } from "react/jsx-runtime";
/**
 * Horizontal input+addon container: joins an input with leading/trailing slots
 * (buttons, icons, text) into one bordered control with shared focus ring and
 * density variants.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
const inputGroupVariants = cva("group/input-group relative flex w-full items-stretch rounded-sm border border-input bg-bg text-sm transition-[border-color,box-shadow]     ", {
    variants: {
        density: {
            default: "min-h-10",
            compact: "min-h-9 text-xs",
            relaxed: "min-h-11",
        },
    },
    defaultVariants: { density: "default" },
});
const InputGroup = React.forwardRef(({ className, density, hasError, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "input-group", "data-error": hasError ? "true" : undefined, className: cn(inputGroupVariants({ density }), hasError &&
        "border-destructive  bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]", "data-[align*=block]:flex-col", className), ...props })));
InputGroup.displayName = "InputGroup";
const inputGroupAddonVariants = cva("flex shrink-0 select-none items-center gap-1.5 px-3 text-muted [&_svg]:size-4 [&_svg]:shrink-0", {
    variants: {
        align: {
            "inline-start": "rounded-s-sm",
            "inline-end": "rounded-e-sm",
            "block-start": "w-full rounded-t-sm border-b border-input px-3 py-1.5",
            "block-end": "w-full rounded-b-sm border-t border-input px-3 py-1.5",
        },
    },
    defaultVariants: { align: "inline-start" },
});
const InputGroupAddon = React.forwardRef(({ className, align, ...props }, ref) => (_jsx("div", { ref: ref, "data-slot": "input-group-addon", "data-align": align ?? "inline-start", className: cn(inputGroupAddonVariants({ align }), className), ...props })));
InputGroupAddon.displayName = "InputGroupAddon";
const InputGroupText = React.forwardRef(({ className, ...props }, ref) => (_jsx("span", { ref: ref, "data-slot": "input-group-text", className: cn("text-sm text-muted leading-none", className), ...props })));
InputGroupText.displayName = "InputGroupText";
const InputGroupInput = React.forwardRef(({ className, type, ...props }, ref) => (_jsx("input", { ref: ref, type: type, "data-slot": "input-group-input", className: cn("min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-txt placeholder:text-muted  disabled:cursor-not-allowed disabled:opacity-50", className), ...props })));
InputGroupInput.displayName = "InputGroupInput";
const InputGroupTextarea = React.forwardRef(({ className, ...props }, ref) => (_jsx("textarea", { ref: ref, "data-slot": "input-group-textarea", className: cn("min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm text-txt placeholder:text-muted  disabled:cursor-not-allowed disabled:opacity-50", className), ...props })));
InputGroupTextarea.displayName = "InputGroupTextarea";
const InputGroupButton = React.forwardRef(({ className, asChild, ...props }, ref) => {
    const Comp = asChild ? Slot : Button;
    return (_jsx(Comp, { ref: ref, "data-slot": "input-group-button", className: cn("rounded-sm", className), ...props }));
});
InputGroupButton.displayName = "InputGroupButton";
export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText, InputGroupTextarea, inputGroupVariants, };
