/**
 * Core-domain client DTOs: Database*, Agent*, ApiError, Runtime*, WebSocket*,
 * ConnectionState*, Sandbox*. One slice of the ElizaClient type surface,
 * re-exported through client-types.ts.
 */
export class ApiError extends Error {
    kind;
    status;
    path;
    /** Application error code from the JSON body (e.g. "rate_limit_exceeded"). */
    code;
    /** Seconds until the caller should retry, from the JSON body or Retry-After header. */
    retryAfter;
    constructor(options) {
        super(options.message);
        this.name = "ApiError";
        this.kind = options.kind;
        this.path = options.path;
        this.status = options.status;
        this.code = options.code;
        this.retryAfter = options.retryAfter;
        if (options.cause !== undefined) {
            this.cause = options.cause;
        }
    }
}
export function isApiError(value) {
    return value instanceof ApiError;
}
export function isRateLimitedError(value) {
    return (value instanceof ApiError &&
        (value.status === 429 || value.code === "rate_limit_exceeded"));
}
