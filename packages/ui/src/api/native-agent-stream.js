/**
 * Native streaming bridge → a real streaming `Response`.
 *
 * The buffered `Agent.request` bridge (android-native-agent-transport.ts) reads
 * the whole loopback response into one string, so an SSE body (the chat reply's
 * token frames) arrives all at once and the WebView never streams. `Agent`
 * gained a `requestStream` method that pushes the response incrementally via
 * `agentStream*` Capacitor events; this turns those events back into a
 * `ReadableStream`-bodied `Response` so the existing SSE parser reads tokens as
 * they arrive.
 *
 * Pure transport glue — the plugin is passed in, so it unit-tests with a fake.
 */
/** Type guard: does this plugin expose the streaming bridge? */
export function supportsNativeStreaming(plugin) {
    if (!plugin || typeof plugin !== "object")
        return false;
    const p = plugin;
    return (typeof p.requestStream === "function" && typeof p.addListener === "function");
}
function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
/**
 * Start a streaming loopback request and resolve with a `Response` whose body is
 * a live `ReadableStream` fed by the native `agentStream*` events. Resolves once
 * the response head arrives; the body streams until `agentStreamComplete`.
 *
 * Listeners attach synchronously after `requestStream` resolves — Capacitor
 * delivers events on a later tick, so no chunk is missed. Cancelling the stream
 * (reader.cancel) or completion detaches every listener.
 */
export async function createNativeStreamingResponse(agent, options) {
    const stream = await agent.requestStream(options);
    const { streamId } = stream;
    let controller = null;
    // Buffer events that land before `start()` runs (and the terminal state if it
    // arrives before any reader pulls), so nothing is dropped on either edge.
    const pending = [];
    let terminal = null;
    const handles = [];
    let detached = false;
    const detach = () => {
        if (detached)
            return;
        detached = true;
        for (const handle of handles)
            void handle.remove();
    };
    const trackHandle = (handle) => {
        if (detached) {
            void handle.remove();
            return;
        }
        handles.push(handle);
    };
    const body = new ReadableStream({
        start(c) {
            controller = c;
            for (const chunk of pending)
                c.enqueue(chunk);
            pending.length = 0;
            if (terminal) {
                if (terminal.error)
                    c.error(new Error(terminal.error));
                else
                    c.close();
                detach();
            }
        },
        cancel() {
            detach();
        },
    });
    let resolveHead;
    let rejectHead;
    const head = new Promise((resolve, reject) => {
        resolveHead = resolve;
        rejectHead = reject;
    });
    // error-policy:J5 unhandled-rejection guard; the rejection IS observed by the
    // caller that consumes the returned `head` promise (line 207) — this keepalive
    // catch only prevents a spurious unhandledrejection if head settles first.
    void head.catch(() => { });
    let headSettled = false;
    const failStream = (reason) => {
        if (detached)
            return;
        const error = reason instanceof Error
            ? reason
            : new Error(String(reason ?? "Stream failed"));
        if (!headSettled) {
            headSettled = true;
            rejectHead(error);
            detach();
            return;
        }
        if (controller) {
            controller.error(error);
            detach();
        }
        else {
            terminal = { error: error.message };
        }
    };
    const onResponse = (event) => {
        const e = event;
        if (!e || e.streamId !== streamId || headSettled)
            return;
        headSettled = true;
        resolveHead(new Response(body, {
            status: e.status,
            statusText: e.statusText ?? "",
            headers: e.headers ?? {},
        }));
    };
    const onChunk = (event) => {
        const e = event;
        if (!e || e.streamId !== streamId || !e.dataBase64)
            return;
        const bytes = base64ToBytes(e.dataBase64);
        if (controller)
            controller.enqueue(bytes);
        else
            pending.push(bytes);
    };
    const onComplete = (event) => {
        const e = event;
        if (!e || e.streamId !== streamId)
            return;
        // A failure before the head ever arrived can't yield a Response — reject the
        // head so the caller falls back / surfaces the error.
        if (e.error && !headSettled) {
            headSettled = true;
            rejectHead(new Error(e.error));
            detach();
            return;
        }
        if (controller) {
            if (e.error)
                controller.error(new Error(e.error));
            else
                controller.close();
            detach();
        }
        else {
            terminal = { error: e.error };
        }
    };
    if (stream.completion) {
        void stream.completion.catch(failStream);
    }
    trackHandle(await agent.addListener("agentStreamResponse", onResponse));
    trackHandle(await agent.addListener("agentStreamChunk", onChunk));
    trackHandle(await agent.addListener("agentStreamComplete", onComplete));
    return head;
}
