import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Shared placeholders + skeletons used across dashboard routes (SPA).
 */
import { Skeleton } from "../../../components/ui/skeleton";
function SkeletonBlock({ className }) {
    return _jsx(Skeleton, { className: className });
}
/**
 * Generic dashboard page skeleton. Matches the rough silhouette of most
 * dashboard pages (page header + a row of stat cards + a list/table) so the
 * Suspense fallback during route-chunk loads doesn't visually flash.
 */
export function DashboardLoadingState({ label }) {
    return (_jsxs("div", { className: "space-y-6", "aria-busy": "true", "aria-label": label ?? "Loading", role: "status", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(SkeletonBlock, { className: "h-7 w-56" }), _jsx(SkeletonBlock, { className: "h-4 w-80 max-w-full" })] }), _jsxs("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4", children: [_jsx(SkeletonBlock, { className: "h-24 w-full" }), _jsx(SkeletonBlock, { className: "h-24 w-full" }), _jsx(SkeletonBlock, { className: "h-24 w-full" }), _jsx(SkeletonBlock, { className: "h-24 w-full" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(SkeletonBlock, { className: "h-12 w-full" }), _jsx(SkeletonBlock, { className: "h-12 w-full" }), _jsx(SkeletonBlock, { className: "h-12 w-full" })] })] }));
}
export function DashboardErrorState({ message }) {
    return (_jsxs("div", { className: "mx-auto max-w-prose space-y-3 p-12 text-sm text-red-300", children: [_jsx("h1", { className: "text-lg font-semibold text-red-100", children: "Something went wrong" }), _jsx("p", { children: message })] }));
}
