function dispatchIttpRouteKernel(kernel, request, context) {
    if (typeof kernel === "function")
        return kernel(request, context);
    return Promise.resolve(kernel.fetch(request));
}
/**
 * In-thread transport protocol adapter.
 *
 * It lets a fetch-shaped route kernel satisfy ElizaClient requests without
 * opening a TCP listener. Android can keep using loopback while iOS uses this
 * path for its in-WebView local agent.
 *
 * Hono apps expose the same `app.fetch(request)` shape, so they can be passed
 * directly once a real shared route kernel exists.
 */
export function createIttpAgentTransport(handler) {
    return {
        request(url, init, context) {
            const request = new Request(url, init);
            return dispatchIttpRouteKernel(handler, request, {
                timeoutMs: context?.timeoutMs,
            });
        },
    };
}
