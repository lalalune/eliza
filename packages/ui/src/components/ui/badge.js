import { jsx as _jsx } from "react/jsx-runtime";
/**
 * Inline status/label pill with cva-driven variants (default, secondary,
 * destructive, outline). A leaf primitive in the components/ui base layer.
 */
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";
const badgeVariants = cva("inline-flex items-center rounded-sm border px-2.5 py-0.5 text-xs font-semibold transition-colors    ", {
    variants: {
        variant: {
            default: "border-transparent bg-primary text-primary-fg hover:bg-primary/80",
            secondary: "border-transparent bg-bg-accent text-txt hover:bg-bg-hover",
            destructive: "border-transparent bg-destructive text-destructive-fg hover:bg-destructive/80",
            outline: "text-txt border-border",
        },
    },
    defaultVariants: {
        variant: "default",
    },
});
function Badge({ className, variant, ...props }) {
    return (_jsx("div", { className: cn(badgeVariants({ variant }), className), ...props }));
}
export { Badge, badgeVariants };
