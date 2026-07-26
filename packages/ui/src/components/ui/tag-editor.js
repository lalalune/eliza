import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Editable list of string tags: an input that adds items on enter and renders
 * each as a removable chip — the tag/keyword editor used in settings and
 * config forms. De-duplicates and reports the full list via `onChange`.
 */
import { X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
function normalizeTagValue(value) {
    return value.trim();
}
export function TagEditor({ items, onChange, label, placeholder = "Add a tag...", className, maxItems, addLabel = "Add", removeLabel = "Remove", }) {
    const [draft, setDraft] = useState("");
    const normalizedItems = useMemo(() => items.map((item) => normalizeTagValue(item)).filter(Boolean), [items]);
    const itemSet = useMemo(() => new Set(normalizedItems.map((item) => item.toLowerCase())), [normalizedItems]);
    const canAddMore = typeof maxItems !== "number" || normalizedItems.length < maxItems;
    const commitDraft = useCallback(() => {
        const next = normalizeTagValue(draft);
        if (!next || !canAddMore || itemSet.has(next.toLowerCase())) {
            setDraft("");
            return;
        }
        onChange([...normalizedItems, next]);
        setDraft("");
    }, [canAddMore, draft, itemSet, normalizedItems, onChange]);
    const removeItem = useCallback((item) => {
        onChange(normalizedItems.filter((candidate) => candidate !== item));
    }, [normalizedItems, onChange]);
    return (_jsxs("div", { className: cn("flex flex-col gap-2", className), children: [label ? _jsx(Label, { children: label }) : null, _jsx("div", { className: "flex flex-wrap gap-2", children: normalizedItems.map((item) => (_jsxs("span", { className: "inline-flex items-center gap-1 rounded-sm border border-border bg-bg-accent px-2.5 py-1 text-xs text-txt", children: [_jsx("span", { children: item }), _jsx(Button, { type: "button", size: "icon", variant: "ghost", className: "h-4 w-4 rounded-sm text-muted hover:text-txt", "aria-label": `${removeLabel} ${item}`, onClick: () => removeItem(item), children: _jsx(X, { className: "h-3 w-3" }) })] }, item))) }), _jsx(Input, { "aria-label": label ?? addLabel, value: draft, onChange: (event) => setDraft(event.target.value), onKeyDown: (event) => {
                    if (event.key !== "Enter" && event.key !== ",")
                        return;
                    event.preventDefault();
                    commitDraft();
                }, onBlur: commitDraft, placeholder: canAddMore ? placeholder : "Tag limit reached", disabled: !canAddMore })] }));
}
