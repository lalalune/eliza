/**
 * Device-bridge: agent-side half of the "inference on the user's phone,
 * agent in a container" architecture.
 *
 * Multi-device aware. Any number of devices can dial in; each `generate`
 * is routed to the highest-scoring connected device at call time. A phone
 * and a Mac paired to the same agent → requests go to the Mac; when the
 * Mac disconnects, new requests fall through to the phone automatically.
 *
 * Scoring (higher = preferred):
 *   - desktop / electrobun: 100 base
 *   - ios / android:        10 base
 *   - per GB of total RAM:  +2
 *   - per GB of VRAM:       +5 (dedicated GPU wins big)
 *   - has loaded the right model already: +50 (avoid a swap)
 *
 * Disconnect tolerance
 * --------------------
 * A pending request stays in `pendingGenerates` until either (a) a device
 * (same or different) returns a matching correlation-id, or (b) the
 * timeout fires. On any device (re)connect we re-route orphaned
 * generates to the new best device.
 *
 * Durability
 * ----------
 * Pending requests are best-effort persisted to a JSON log under
 * `$ELIZA_STATE_DIR/local-inference/pending-requests.json` so a brief
 * agent restart doesn't lose the queue. Persistence is async and
 * non-blocking — failures fall back to in-memory only.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "@elizaos/logger";
import { computeGenerationThroughput, } from "@elizaos/shared/local-inference";
import { localInferenceRoot } from "./paths";
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const PENDING_LOG_FILENAME = "pending-requests.json";
function isWsModule(value) {
    if (!value || typeof value !== "object")
        return false;
    const WebSocketServer = Reflect.get(value, "WebSocketServer");
    const WebSocket = Reflect.get(value, "WebSocket");
    if (typeof WebSocketServer !== "function" ||
        typeof WebSocket !== "function") {
        return false;
    }
    return (typeof Reflect.get(WebSocket, "OPEN") === "number" &&
        typeof Reflect.get(WebSocket, "CLOSED") === "number");
}
async function importWsModule() {
    const mod = await import("ws");
    if (!isWsModule(mod)) {
        throw new Error("ws module did not expose WebSocketServer/WebSocket");
    }
    return mod;
}
/**
 * Scoring function — pick the most powerful device available.
 * Pure, synchronous, and easy to test.
 */
function scoreDevice(device, opts = {}) {
    const cap = device.capabilities;
    const platformBase = cap.platform === "desktop" || cap.platform === "electrobun"
        ? 100
        : cap.platform === "ios" || cap.platform === "android"
            ? 10
            : 0;
    const usableRamGb = typeof cap.availableRamGb === "number" && cap.availableRamGb > 0
        ? Math.min(cap.totalRamGb, Math.max(cap.availableRamGb, cap.totalRamGb * 0.6))
        : cap.totalRamGb;
    const ramScore = usableRamGb * 2;
    const vramScore = cap.gpu?.available
        ? (cap.gpu.totalVramGb ?? cap.totalRamGb) * 5
        : 0;
    const healthPenalty = cap.lowPowerMode || cap.thermalState === "serious"
        ? 15
        : cap.thermalState === "critical"
            ? 100
            : 0;
    const loadedBonus = opts.preferLoadedPath && device.loadedPath === opts.preferLoadedPath
        ? 50
        : 0;
    return platformBase + ramScore + vramScore + loadedBonus - healthPenalty;
}
export class DeviceBridge {
    devices = new Map();
    wss = null;
    restored = false;
    pendingLoads = new Map();
    pendingUnloads = new Map();
    pendingGenerates = new Map();
    pendingEmbeds = new Map();
    statusListeners = new Set();
    generationMetricsListeners = new Set();
    /** The most recent successful generation's metrics, or null. */
    lastGenerationMetrics = null;
    expectedPairingToken = process.env.ELIZA_DEVICE_PAIRING_TOKEN?.trim() || null;
    status() {
        const summaries = [];
        for (const device of this.devices.values()) {
            const score = scoreDevice(device);
            const activeRequests = this.countRouted(this.pendingGenerates, device.deviceId) +
                this.countRouted(this.pendingEmbeds, device.deviceId) +
                this.countRouted(this.pendingLoads, device.deviceId) +
                this.countRouted(this.pendingUnloads, device.deviceId);
            summaries.push({
                deviceId: device.deviceId,
                capabilities: device.capabilities,
                loadedPath: device.loadedPath,
                connectedSince: new Date(device.connectedAt).toISOString(),
                score,
                activeRequests,
                isPrimary: false,
            });
        }
        // Sort desc by score so the UI can just render in order.
        summaries.sort((a, b) => b.score - a.score);
        if (summaries[0])
            summaries[0].isPrimary = true;
        const primary = summaries[0] ?? null;
        const pendingRequests = this.pendingGenerates.size +
            this.pendingEmbeds.size +
            this.pendingLoads.size +
            this.pendingUnloads.size;
        return {
            connected: summaries.length > 0,
            devices: summaries,
            primaryDeviceId: primary?.deviceId ?? null,
            pendingRequests,
            deviceId: primary?.deviceId ?? null,
            capabilities: primary?.capabilities ?? null,
            loadedPath: primary?.loadedPath ?? null,
            connectedSince: primary?.connectedSince ?? null,
        };
    }
    countRouted(map, deviceId) {
        let n = 0;
        for (const value of map.values()) {
            if (value.routedDeviceId === deviceId)
                n += 1;
        }
        return n;
    }
    subscribeStatus(listener) {
        this.statusListeners.add(listener);
        return () => {
            this.statusListeners.delete(listener);
        };
    }
    emitStatus() {
        const snapshot = this.status();
        for (const listener of this.statusListeners) {
            try {
                listener(snapshot);
            }
            catch {
                // error-policy:J4 a throwing subscriber is evicted so one broken
                // listener cannot starve the rest of the fan-out.
                this.statusListeners.delete(listener);
            }
        }
    }
    /**
     * Subscribe to per-generation throughput metrics. Fires once per successful
     * on-device generation with the differenced prefill/decode tok/s. Returns an
     * unsubscribe function.
     */
    subscribeGenerationMetrics(listener) {
        this.generationMetricsListeners.add(listener);
        return () => {
            this.generationMetricsListeners.delete(listener);
        };
    }
    /** The most recent successful generation's measured metrics, or null. */
    latestGenerationMetrics() {
        return this.lastGenerationMetrics;
    }
    emitGenerationMetrics(metrics) {
        this.lastGenerationMetrics = metrics;
        for (const listener of this.generationMetricsListeners) {
            try {
                listener(metrics);
            }
            catch {
                this.generationMetricsListeners.delete(listener);
            }
        }
    }
    async attachToHttpServer(server) {
        if (this.wss)
            return;
        const ws = await importWsModule();
        const wss = new ws.WebSocketServer({
            noServer: true,
            maxPayload: 1024 * 1024,
        });
        this.wss = wss;
        wss.on("error", (err) => {
            logger.warn("[device-bridge] WSS error:", err.message);
        });
        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", "http://localhost");
            if (url.pathname !== "/api/local-inference/device-bridge")
                return;
            wss.handleUpgrade(request, socket, head, (client) => {
                this.handleConnection(client, ws.WebSocket, url);
            });
        });
        // Restore persisted pending generates the first time a server attaches.
        // We only restore once per process — avoids double-resubmit on repeated
        // server restarts inside the same worker.
        if (!this.restored) {
            this.restored = true;
            await this.restorePendingGenerates();
        }
    }
    handleConnection(socket, WsCtor, url) {
        const queryToken = url.searchParams.get("token")?.trim();
        if (this.expectedPairingToken && queryToken !== this.expectedPairingToken) {
            logger.warn("[device-bridge] Rejecting connection: bad query token");
            socket.close(4001, "unauthorized");
            return;
        }
        let registered = false;
        let registeredDeviceId = null;
        socket.on("message", (raw) => {
            let msg;
            try {
                const text = typeof raw === "string" ? raw : raw.toString("utf8");
                msg = JSON.parse(text);
            }
            catch {
                logger.warn("[device-bridge] Ignoring non-JSON frame");
                return;
            }
            if (!registered) {
                if (msg.type !== "register") {
                    logger.warn("[device-bridge] First frame must be register");
                    socket.close(4002, "must-register-first");
                    return;
                }
                if (this.expectedPairingToken &&
                    msg.payload.pairingToken !== this.expectedPairingToken) {
                    logger.warn("[device-bridge] Rejecting register: bad pairing token");
                    socket.close(4001, "unauthorized");
                    return;
                }
                registered = true;
                registeredDeviceId = msg.payload.deviceId;
                this.onDeviceRegistered(socket, WsCtor, msg.payload);
                return;
            }
            this.handleDeviceMessage(msg);
        });
        socket.on("close", () => {
            if (!registered || !registeredDeviceId)
                return;
            // Only evict if THIS socket is still the current one for the
            // deviceId. When a newer connection supersedes us, its registration
            // already replaced the map entry; the delayed close event from our
            // superseded socket must not tear that down.
            const current = this.devices.get(registeredDeviceId);
            if (current && current.socket === socket) {
                this.onDeviceDisconnected(registeredDeviceId);
            }
        });
        socket.on("error", (err) => {
            logger.warn("[device-bridge] Socket error:", err.message);
        });
    }
    onDeviceRegistered(socket, WsCtor, registration) {
        // Supersede any existing connection under the same deviceId.
        const existing = this.devices.get(registration.deviceId);
        if (existing) {
            try {
                existing.socket.close(4003, "superseded");
            }
            catch {
                /* best effort */
            }
            clearInterval(existing.heartbeatTimer);
        }
        const device = {
            deviceId: registration.deviceId,
            socket,
            capabilities: registration.capabilities,
            loadedPath: registration.loadedPath,
            connectedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            heartbeatTimer: setInterval(() => {
                if (socket.readyState !== WsCtor.OPEN)
                    return;
                try {
                    this.sendToDevice(device.deviceId, { type: "ping", at: Date.now() });
                }
                catch {
                    /* ignore after close */
                }
            }, HEARTBEAT_INTERVAL_MS),
        };
        if (typeof device.heartbeatTimer === "object" &&
            device.heartbeatTimer &&
            "unref" in device.heartbeatTimer) {
            device.heartbeatTimer.unref();
        }
        this.devices.set(device.deviceId, device);
        logger.info(`[device-bridge] Device connected: ${device.deviceId} (${device.capabilities.platform}, score=${scoreDevice(device)})`);
        // Re-route any orphaned generates (the ones whose prior routed device
        // disconnected). Load/unload orphans reject — device-specific state.
        for (const pending of this.pendingLoads.values()) {
            if (pending.routedDeviceId === device.deviceId)
                continue;
            if (!this.devices.has(pending.routedDeviceId)) {
                clearTimeout(pending.timeout);
                this.pendingLoads.delete(pending.correlationId);
                pending.reject(new Error("DEVICE_RECONNECTED: retry model load after reconnect"));
            }
        }
        for (const pending of this.pendingUnloads.values()) {
            if (!this.devices.has(pending.routedDeviceId)) {
                clearTimeout(pending.timeout);
                this.pendingUnloads.delete(pending.correlationId);
                pending.reject(new Error("DEVICE_RECONNECTED: retry model unload after reconnect"));
            }
        }
        for (const pending of this.pendingGenerates.values()) {
            if (pending.routedDeviceId === null) {
                const best = this.pickBestDevice();
                if (best) {
                    pending.routedDeviceId = best.deviceId;
                    try {
                        this.sendToDevice(best.deviceId, pending.request);
                    }
                    catch (err) {
                        pending.reject(err instanceof Error
                            ? err
                            : new Error("Failed to re-route after reconnect"));
                    }
                }
            }
        }
        // Same re-route logic for orphaned embeds. Embeds are short-lived and
        // idempotent (the device just runs llama_get_embeddings), so we can
        // safely retarget them on reconnect.
        for (const pending of this.pendingEmbeds.values()) {
            if (pending.routedDeviceId === null) {
                const best = this.pickBestDevice();
                if (best) {
                    pending.routedDeviceId = best.deviceId;
                    try {
                        this.sendToDevice(best.deviceId, pending.request);
                    }
                    catch (err) {
                        pending.reject(err instanceof Error
                            ? err
                            : new Error("Failed to re-route after reconnect"));
                    }
                }
            }
        }
        this.emitStatus();
    }
    onDeviceDisconnected(deviceId) {
        const device = this.devices.get(deviceId);
        if (!device)
            return;
        clearInterval(device.heartbeatTimer);
        this.devices.delete(deviceId);
        // Orphan any generates / embeds routed to this device so they can be
        // re-routed to a surviving device (or await a reconnect).
        let orphaned = 0;
        for (const pending of this.pendingGenerates.values()) {
            if (pending.routedDeviceId === deviceId) {
                pending.routedDeviceId = null;
                orphaned += 1;
            }
        }
        for (const pending of this.pendingEmbeds.values()) {
            if (pending.routedDeviceId === deviceId) {
                pending.routedDeviceId = null;
                orphaned += 1;
            }
        }
        logger.info(`[device-bridge] Device disconnected: ${deviceId}; ${orphaned} request(s) orphaned`);
        // Fast-path: if there are other connected devices, re-route now.
        if (this.devices.size > 0) {
            for (const pending of this.pendingGenerates.values()) {
                if (pending.routedDeviceId === null) {
                    const best = this.pickBestDevice();
                    if (best) {
                        pending.routedDeviceId = best.deviceId;
                        try {
                            this.sendToDevice(best.deviceId, pending.request);
                        }
                        catch {
                            /* will be retried on the next reconnect */
                        }
                    }
                }
            }
            for (const pending of this.pendingEmbeds.values()) {
                if (pending.routedDeviceId === null) {
                    const best = this.pickBestDevice();
                    if (best) {
                        pending.routedDeviceId = best.deviceId;
                        try {
                            this.sendToDevice(best.deviceId, pending.request);
                        }
                        catch {
                            /* will be retried on the next reconnect */
                        }
                    }
                }
            }
        }
        this.emitStatus();
    }
    handleDeviceMessage(msg) {
        if (msg.type === "pong") {
            // Heartbeat round-trip — could update lastHeartbeatAt per device, but
            // we don't currently use it for eviction.
            return;
        }
        if (msg.type === "loadResult") {
            const pending = this.pendingLoads.get(msg.correlationId);
            if (!pending)
                return;
            clearTimeout(pending.timeout);
            this.pendingLoads.delete(msg.correlationId);
            if (msg.ok === false) {
                pending.reject(new Error(msg.error));
            }
            else {
                const device = this.devices.get(pending.routedDeviceId);
                if (device)
                    device.loadedPath = msg.loadedPath;
                pending.resolve();
                this.emitStatus();
            }
            return;
        }
        if (msg.type === "unloadResult") {
            const pending = this.pendingUnloads.get(msg.correlationId);
            if (!pending)
                return;
            clearTimeout(pending.timeout);
            this.pendingUnloads.delete(msg.correlationId);
            if (msg.ok === false) {
                pending.reject(new Error(msg.error));
            }
            else {
                const device = this.devices.get(pending.routedDeviceId);
                if (device)
                    device.loadedPath = null;
                pending.resolve();
                this.emitStatus();
            }
            return;
        }
        if (msg.type === "generateResult") {
            const pending = this.pendingGenerates.get(msg.correlationId);
            if (!pending)
                return;
            clearTimeout(pending.timeout);
            this.pendingGenerates.delete(msg.correlationId);
            // Best-effort purge the persisted copy.
            void this.persistPendingGenerates();
            if (msg.ok === false) {
                pending.reject(new Error(msg.error));
            }
            else {
                // Difference the raw counters into prefill/decode tok/s and surface
                // them to profiling subscribers. The loader contract is unchanged —
                // callers still get the text; metrics are a side channel.
                const ttftMs = typeof msg.ttftMs === "number" ? msg.ttftMs : null;
                const throughput = computeGenerationThroughput({
                    promptTokens: msg.promptTokens,
                    outputTokens: msg.outputTokens,
                    durationMs: msg.durationMs,
                    ttftMs,
                });
                const device = pending.routedDeviceId
                    ? this.devices.get(pending.routedDeviceId)
                    : null;
                this.emitGenerationMetrics({
                    deviceId: pending.routedDeviceId ?? "unknown",
                    platform: device?.capabilities.platform ?? null,
                    deviceModel: device?.capabilities.deviceModel ?? null,
                    promptTokens: msg.promptTokens,
                    outputTokens: msg.outputTokens,
                    durationMs: msg.durationMs,
                    ttftMs,
                    throughput,
                });
                pending.resolve(msg.text);
            }
            return;
        }
        if (msg.type === "embedResult") {
            const pending = this.pendingEmbeds.get(msg.correlationId);
            if (!pending)
                return;
            clearTimeout(pending.timeout);
            this.pendingEmbeds.delete(msg.correlationId);
            if (msg.ok === false) {
                pending.reject(new Error(msg.error));
            }
            else {
                pending.resolve({ embedding: msg.embedding, tokens: msg.tokens });
            }
            return;
        }
    }
    sendToDevice(deviceId, msg) {
        const device = this.devices.get(deviceId);
        if (!device)
            throw new Error(`DEVICE_DISCONNECTED: ${deviceId}`);
        device.socket.send(JSON.stringify(msg));
    }
    /** Highest-scoring connected device, optionally boosted for an already-loaded model. */
    pickBestDevice(opts) {
        let best = null;
        let bestScore = -Infinity;
        for (const device of this.devices.values()) {
            const score = scoreDevice(device, opts);
            if (score > bestScore) {
                best = device;
                bestScore = score;
            }
        }
        return best;
    }
    // ── LocalInferenceLoader surface ──────────────────────────────────────
    async loadModel(args) {
        const best = this.pickBestDevice({ preferLoadedPath: args.modelPath });
        if (!best) {
            throw new Error("DEVICE_DISCONNECTED: no mobile / desktop bridge device attached");
        }
        const correlationId = randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingLoads.delete(correlationId);
                reject(new Error("DEVICE_TIMEOUT: model load exceeded deadline"));
            }, DEFAULT_LOAD_TIMEOUT_MS);
            if (typeof timeout === "object" && timeout && "unref" in timeout) {
                timeout.unref();
            }
            this.pendingLoads.set(correlationId, {
                correlationId,
                modelPath: args.modelPath,
                resolve,
                reject,
                timeout,
                routedDeviceId: best.deviceId,
            });
            try {
                this.sendToDevice(best.deviceId, {
                    type: "load",
                    correlationId,
                    ...args,
                });
            }
            catch (err) {
                clearTimeout(timeout);
                this.pendingLoads.delete(correlationId);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    async unloadModel() {
        // Unload every device that currently has a model loaded. Best-effort —
        // individual failures don't block the others.
        const targets = [...this.devices.values()].filter((d) => d.loadedPath);
        if (targets.length === 0)
            return;
        await Promise.allSettled(targets.map((device) => new Promise((resolve, reject) => {
            const correlationId = randomUUID();
            const timeout = setTimeout(() => {
                this.pendingUnloads.delete(correlationId);
                reject(new Error("DEVICE_TIMEOUT: unload exceeded deadline"));
            }, DEFAULT_CALL_TIMEOUT_MS);
            if (typeof timeout === "object" && timeout && "unref" in timeout) {
                timeout.unref();
            }
            this.pendingUnloads.set(correlationId, {
                correlationId,
                resolve,
                reject,
                timeout,
                routedDeviceId: device.deviceId,
            });
            try {
                this.sendToDevice(device.deviceId, {
                    type: "unload",
                    correlationId,
                });
            }
            catch (err) {
                clearTimeout(timeout);
                this.pendingUnloads.delete(correlationId);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        })));
    }
    currentModelPath() {
        // The primary device's loaded path wins — consistent with which device
        // would actually run the next generate.
        const best = this.pickBestDevice();
        return best?.loadedPath ?? null;
    }
    async embed(args) {
        const envTimeout = Number.parseInt(process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS?.trim() ?? "", 10);
        const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0
            ? envTimeout
            : DEFAULT_CALL_TIMEOUT_MS;
        const correlationId = randomUUID();
        const request = {
            type: "embed",
            correlationId,
            input: args.input,
        };
        const best = this.pickBestDevice();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingEmbeds.delete(correlationId);
                reject(new Error(`DEVICE_TIMEOUT: no device responded to embed within ${timeoutMs}ms`));
            }, timeoutMs);
            if (typeof timeout === "object" && timeout && "unref" in timeout) {
                timeout.unref();
            }
            const pending = {
                correlationId,
                resolve,
                reject,
                timeout,
                request,
                routedDeviceId: best?.deviceId ?? null,
                submittedAt: new Date().toISOString(),
            };
            this.pendingEmbeds.set(correlationId, pending);
            if (best) {
                try {
                    this.sendToDevice(best.deviceId, request);
                }
                catch {
                    // Routed device went away between pickBestDevice and send.
                    // Mark as orphaned; reroute logic will pick it up on the next
                    // device (re)connect.
                    pending.routedDeviceId = null;
                }
            }
            else {
                logger.debug(`[device-bridge] No device available; parking embed ${correlationId} pending connection`);
            }
        });
    }
    async generate(args) {
        const envTimeout = Number.parseInt(process.env.ELIZA_DEVICE_GENERATE_TIMEOUT_MS?.trim() ?? "", 10);
        const timeoutMs = Number.isFinite(envTimeout) && envTimeout > 0
            ? envTimeout
            : DEFAULT_CALL_TIMEOUT_MS;
        const correlationId = randomUUID();
        const request = {
            type: "generate",
            correlationId,
            prompt: args.prompt,
            stopSequences: args.stopSequences,
            maxTokens: args.maxTokens,
            temperature: args.temperature,
        };
        const best = this.pickBestDevice();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingGenerates.delete(correlationId);
                void this.persistPendingGenerates();
                reject(new Error(`DEVICE_TIMEOUT: no device responded within ${timeoutMs}ms`));
            }, timeoutMs);
            if (typeof timeout === "object" && timeout && "unref" in timeout) {
                timeout.unref();
            }
            const pending = {
                correlationId,
                resolve,
                reject,
                timeout,
                request,
                routedDeviceId: best?.deviceId ?? null,
                submittedAt: new Date().toISOString(),
            };
            this.pendingGenerates.set(correlationId, pending);
            void this.persistPendingGenerates();
            if (best) {
                try {
                    this.sendToDevice(best.deviceId, request);
                }
                catch {
                    pending.routedDeviceId = null;
                }
            }
            else {
                logger.debug(`[device-bridge] No device available; parking generate ${correlationId} pending connection`);
            }
        });
    }
    // ── Durability ────────────────────────────────────────────────────────
    pendingLogPath() {
        return path.join(localInferenceRoot(), PENDING_LOG_FILENAME);
    }
    /**
     * Rewrite the pending-generate log. Called after every mutation to the
     * pendingGenerates map. We only persist `generate` — loads/unloads are
     * bound to a specific device's current state and aren't safely replayable
     * across restart.
     */
    async persistPendingGenerates() {
        try {
            await fs.mkdir(localInferenceRoot(), { recursive: true });
            const payload = [
                ...this.pendingGenerates.values(),
            ].map((p) => ({
                correlationId: p.correlationId,
                request: p.request,
                submittedAt: p.submittedAt,
            }));
            const tmp = `${this.pendingLogPath()}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
            await fs.rename(tmp, this.pendingLogPath());
        }
        catch (err) {
            logger.debug("[device-bridge] Failed to persist pending generates:", err instanceof Error ? err.message : String(err));
        }
    }
    /**
     * On startup, read persisted pending requests back into memory. Their
     * promises are gone (the original caller's process is dead) so they can
     * only be resolved externally, so we re-queue them with a fresh timeout.
     * The first connected device that can handle generation will process them.
     * If nothing consumes them within the timeout they reject quietly.
     *
     * Stale entries older than 24h are purged rather than resurrected.
     */
    async restorePendingGenerates() {
        let raw;
        try {
            raw = await fs.readFile(this.pendingLogPath(), "utf8");
        }
        catch {
            // error-policy:J3 no pending-generates log is the normal cold-start
            // state — nothing to restore.
            return;
        }
        let items;
        try {
            items = JSON.parse(raw);
            if (!Array.isArray(items))
                return;
        }
        catch {
            // error-policy:J3 corrupt pending log starts clean — requesters have
            // their own timeouts (see the restore contract in the method doc).
            return;
        }
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        let restored = 0;
        for (const item of items) {
            if (!item.correlationId ||
                !item.request ||
                item.request.type !== "generate") {
                continue;
            }
            const submittedAt = Date.parse(item.submittedAt);
            if (!Number.isFinite(submittedAt) || submittedAt < cutoff)
                continue;
            if (this.pendingGenerates.has(item.correlationId))
                continue;
            // The original caller's promise is gone. Queue the request so the
            // first connecting device processes it; if nobody picks it up within
            // the default timeout, drop it.
            const timeout = setTimeout(() => {
                this.pendingGenerates.delete(item.correlationId);
                void this.persistPendingGenerates();
            }, DEFAULT_CALL_TIMEOUT_MS);
            if (typeof timeout === "object" && timeout && "unref" in timeout) {
                timeout.unref();
            }
            this.pendingGenerates.set(item.correlationId, {
                correlationId: item.correlationId,
                request: item.request,
                submittedAt: item.submittedAt,
                routedDeviceId: null,
                timeout,
                resolve: () => {
                    /* no caller to resolve */
                },
                reject: () => {
                    /* no caller to reject */
                },
            });
            restored += 1;
        }
        if (restored > 0) {
            logger.info(`[device-bridge] Restored ${restored} pending generate(s) from persistent log`);
        }
    }
}
export const deviceBridge = new DeviceBridge();
export function registerDeviceBridgeLoader(runtime) {
    if (typeof runtime.registerService !== "function")
        return;
    const loader = {
        async loadModel(args) {
            await deviceBridge.loadModel(args);
        },
        async unloadModel() {
            await deviceBridge.unloadModel();
        },
        currentModelPath() {
            return deviceBridge.currentModelPath();
        },
        async generate(args) {
            return deviceBridge.generate(args);
        },
        async embed(args) {
            return deviceBridge.embed(args);
        },
    };
    runtime.registerService("localInferenceLoader", loader);
    logger.info("[device-bridge] Registered device-bridge loader for remote on-device inference");
}
