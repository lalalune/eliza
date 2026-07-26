/**
 * Side-registry of model handlers registered on an AgentRuntime.
 *
 * elizaOS core owns the model registry; this module mirrors it for the UI so
 * we can render a live [ModelType × Provider] routing table. It stays in sync
 * through the public core API — {@link IAgentRuntime.getModelRegistrations} for
 * the initial snapshot and the `MODEL_REGISTERED` runtime event for subsequent
 * registrations — instead of patching `AgentRuntime.prototype.registerModel`.
 *
 * The registry holds registration metadata only (never handler functions):
 * dispatch and provider failover are core's job via `runtime.useModel`, so the
 * UI never captures or invokes handlers.
 */
class HandlerRegistry {
    registrations = new Map();
    listeners = new Set();
    installedOn = new WeakSet();
    /**
     * Snapshot of all registrations grouped by model type, sorted by
     * priority descending inside each group (matches core's selection
     * order). Callers must not mutate the returned array.
     */
    getAll() {
        const out = [];
        for (const list of this.registrations.values()) {
            out.push(...list);
        }
        return out;
    }
    /** All registrations for a given model type, sorted by priority desc. */
    getForType(modelType) {
        const list = this.registrations.get(modelType);
        return list ? [...list] : [];
    }
    /** Registrations for a model type excluding a specific provider. */
    getForTypeExcluding(modelType, excludeProvider) {
        return this.getForType(modelType).filter((r) => r.provider !== excludeProvider);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    emit() {
        const snapshot = this.getAll();
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            }
            catch {
                this.listeners.delete(listener);
            }
        }
    }
    record(reg) {
        const existing = this.registrations.get(reg.modelType) ?? [];
        // Replace any prior registration from the same provider for this
        // model type. Core allows multiple providers per type but only one
        // registration per (type, provider) pair — last write wins.
        const filtered = existing.filter((r) => r.provider !== reg.provider);
        filtered.push(reg);
        filtered.sort((a, b) => b.priority - a.priority);
        this.registrations.set(reg.modelType, filtered);
        this.emit();
    }
    /**
     * Mirror a runtime's model registry into this side-registry. Idempotent
     * per runtime instance. Seeds from the current registrations, then stays
     * live via the `MODEL_REGISTERED` event — no prototype patching, no
     * handler capture.
     */
    installOn(runtime) {
        if (this.installedOn.has(runtime))
            return;
        this.installedOn.add(runtime);
        const now = new Date().toISOString();
        for (const reg of runtime.getModelRegistrations()) {
            this.record({
                modelType: reg.modelType,
                provider: reg.provider,
                priority: reg.priority,
                registeredAt: now,
            });
        }
        runtime.registerEvent("MODEL_REGISTERED", async (payload) => {
            this.record({
                modelType: payload.modelType,
                provider: payload.provider,
                priority: payload.priority,
                registeredAt: new Date().toISOString(),
            });
        });
    }
}
export const handlerRegistry = new HandlerRegistry();
export function toPublicRegistration(reg) {
    return {
        modelType: reg.modelType,
        provider: reg.provider,
        priority: reg.priority,
        registeredAt: reg.registeredAt,
    };
}
