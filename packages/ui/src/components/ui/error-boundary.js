import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Class error boundary that catches render throws in its subtree and shows a
 * heading + retry-button fallback (overridable via `fallback`). The optional
 * `onError` hook lets a wrapper such as ViewErrorBoundary fire crash telemetry
 * without re-implementing the boundary.
 */
import * as React from "react";
import { Button } from "./button";
export class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, errorInfo) {
        // error captured in state via getDerivedStateFromError; fallback UI is rendered.
        // Surface it to an optional observer (crash telemetry) without throwing.
        try {
            this.props.onError?.(error, errorInfo);
        }
        catch {
            // never let a telemetry hook mask the original crash
        }
    }
    resetErrorBoundary = () => {
        this.setState({ error: null });
    };
    render() {
        if (this.state.error) {
            if (this.props.fallback) {
                return this.props.fallback(this.state.error, this.resetErrorBoundary);
            }
            return (_jsxs("div", { className: "flex flex-col items-center justify-center gap-3 p-6 text-center border border-destructive/30 bg-destructive/5 rounded-sm", children: [_jsx("p", { className: "text-sm font-semibold text-destructive", children: this.props.errorLabel ?? "Something went wrong" }), _jsx("p", { className: "text-xs text-muted max-w-sm", children: this.state.error.message }), _jsx(Button, { type: "button", variant: "outline", size: "sm", className: "rounded-sm text-xs", onClick: this.resetErrorBoundary, children: this.props.retryLabel ?? "Try Again" })] }));
        }
        return this.props.children;
    }
}
