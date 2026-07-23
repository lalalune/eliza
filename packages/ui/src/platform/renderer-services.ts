/**
 * Owns long-lived renderer work such as pollers, native listeners, and capture
 * loops so plugins cannot orphan resources outside React.
 *
 * Plugin registration entries declare shell-scoped definitions; the app shell
 * installs one host per renderer window. The host retains and awaits every
 * cleanup on suspension, teardown, host replacement, and HMR re-registration.
 * One transition queue ensures a successor never starts before its predecessor
 * has completely released native resources. Registration order does not
 * matter, and rapid replacements coalesce to the latest generation.
 *
 * A `globalThis` store preserves single ownership across duplicated module
 * evaluations. Stops abort pending starts immediately and await late cleanup.
 * Persisted `pagehide` suspends external resources; `pageshow` starts a fresh
 * serialized generation. Missing cleanup is a contract failure (#16504,
 * #17110).
 */

/**
 * Renderer window shells the app boots. Only the app shell assigns these; a
 * service declares which shells it may run in via `shells`, so background work
 * like LifeOps activity capture runs once in the primary window instead of in
 * every popout/detached/companion renderer.
 */
export type RendererShellKind =
  | "main"
  | "popout"
  | "detached"
  | "chat-overlay"
  | "tray-popover"
  | "phone-companion"
  | "app-window"
  | "model-tester"
  | "embed";

/** Passed to a service `start`; `signal` aborts when this instance is stopped. */
export interface RendererServiceContext {
  shell: RendererShellKind;
  signal: AbortSignal;
}

/** Releases every resource acquired by a service; the host awaits completion. */
export type RendererServiceCleanup = () => void | Promise<void>;

export interface RendererServiceDefinition {
  /** Globally unique, stable id, e.g. "personal-assistant.lifeops-activity-signals". */
  id: string;
  /** Shell kinds this service is allowed to run in. */
  shells: readonly RendererShellKind[];
  /**
   * Start the service. Must return (or resolve to) the cleanup that undoes
   * every listener/interval/native handle it installed. May be async; the host
   * guarantees the cleanup still runs and settles if stopped mid-start.
   */
  start: (
    context: RendererServiceContext,
  ) => RendererServiceCleanup | Promise<RendererServiceCleanup>;
}

export type RendererServiceStatus =
  | "registered"
  | "ineligible"
  | "starting"
  | "running"
  | "failed"
  | "stopped";

export interface RendererServiceState {
  id: string;
  shells: readonly RendererShellKind[];
  status: RendererServiceStatus;
}

export type RendererServiceErrorReporter = (
  serviceId: string,
  error: unknown,
  phase: "start" | "cleanup",
) => void;

export interface RendererServiceHostHandle {
  shell: RendererShellKind;
  /** Stop every running/starting instance and await all owned cleanup. */
  dispose: () => Promise<void>;
}

interface ServiceInstance {
  definition: RendererServiceDefinition;
  definitionVersion: number;
  controller: AbortController;
  status: "starting" | "running" | "failed" | "stopped";
  cleanup: RendererServiceCleanup | null;
  /** Settles after start and any late cleanup caused by a concurrent stop. */
  startPromise: Promise<void>;
  /** Shared by every stop request so cleanup is invoked and awaited once. */
  stopPromise: Promise<void> | null;
  /** Pre-#17110 field retained only while an HMR store is upgraded in place. */
  settled?: Promise<void>;
}

interface HostState {
  shell: RendererShellKind;
  reportError: RendererServiceErrorReporter;
  instances: Map<string, ServiceInstance>;
  detachPageEvents: (() => void) | null;
  /** Pre-#17110 pagehide disposer retained for in-place HMR store upgrades. */
  detachPagehide?: (() => void) | null;
  disposed: boolean;
  suspended: boolean;
  disposePromise: Promise<void> | null;
}

interface RendererServiceStore {
  definitions: Map<string, RendererServiceDefinition>;
  definitionVersions: Map<string, number>;
  nextDefinitionVersion: number;
  host: HostState | null;
  /** The tail of the ownership queue; every successor is chained here. */
  transition: Promise<void>;
}

// Why a `globalThis` store and not a module-local one, given the #12091
// "kill globalThis bridges" doctrine: this registry's single invariant is that
// exactly one copy owns the running instances, but the renderer cannot
// guarantee single evaluation of this module — dev HMR re-evaluates it, and a
// plugin registration chunk and the app shell chunk can each bundle their own
// copy (mixed chunk graphs). A module-local store forks per evaluation, which
// is precisely the double-ownership bug this exists to prevent. Routing
// through the app's loader-identity cache instead was rejected because it
// inverts the dependency direction (#12091: packages/ui must not reach into
// packages/app machinery) and would leave non-app hosts (tests, storybook-like
// harnesses) without a registry. Symbol.for gives every copy the same key
// without exporting a mutable global surface; `resetRendererServicesForTest`
// is the only sanctioned reset path.
const STORE_KEY = Symbol.for("elizaos.renderer-services.store");

function getStore(): RendererServiceStore {
  const holder = globalThis as { [STORE_KEY]?: RendererServiceStore };
  if (!holder[STORE_KEY]) {
    holder[STORE_KEY] = {
      definitions: new Map(),
      definitionVersions: new Map(),
      nextDefinitionVersion: 0,
      host: null,
      transition: Promise.resolve(),
    };
  }
  const store = holder[STORE_KEY];

  // HMR deliberately preserves this global store across module evaluations.
  // Upgrade the pre-#17110 shape in place so the lifecycle fix can take
  // ownership of already-running services instead of crashing on missing queue
  // fields or leaking the old pagehide listener.
  store.definitionVersions ??= new Map();
  store.nextDefinitionVersion ??= 0;
  store.transition ??= Promise.resolve();
  for (const id of store.definitions.keys()) {
    if (!store.definitionVersions.has(id)) {
      store.nextDefinitionVersion += 1;
      store.definitionVersions.set(id, store.nextDefinitionVersion);
    }
  }
  const host = store.host;
  if (host) {
    host.suspended ??= false;
    host.disposePromise ??= null;
    if (!host.detachPageEvents && host.detachPagehide) {
      host.detachPageEvents = host.detachPagehide;
    }
    for (const [id, instance] of host.instances) {
      instance.definitionVersion ??= store.definitionVersions.get(id) ?? 0;
      instance.startPromise ??= instance.settled ?? Promise.resolve();
      instance.stopPromise ??= null;
    }
  }
  return store;
}

const LOG_PREFIX = "[RendererServices]";

const defaultReportError: RendererServiceErrorReporter = (
  serviceId,
  error,
  phase,
) => {
  console.error(`${LOG_PREFIX} service "${serviceId}" ${phase} failed:`, error);
};

function reportServiceError(
  host: HostState,
  serviceId: string,
  error: unknown,
  phase: "start" | "cleanup",
): void {
  try {
    host.reportError(serviceId, error, phase);
  } catch (reporterError) {
    // The reporter is an observability boundary, not part of resource
    // ownership. Its own failure must stay visible without poisoning the
    // serialized lifecycle queue and stranding every later transition.
    defaultReportError(
      serviceId,
      new AggregateError(
        [error, reporterError],
        `renderer service error reporter failed during ${phase}`,
      ),
      phase,
    );
  }
}

function enqueueTransition(
  store: RendererServiceStore,
  transition: () => Promise<void>,
): Promise<void> {
  const scheduled = store.transition.then(transition);
  store.transition = scheduled;
  return scheduled;
}

async function runCleanup(
  host: HostState,
  instance: ServiceInstance,
): Promise<void> {
  const cleanup = instance.cleanup;
  instance.cleanup = null;
  if (!cleanup) return;
  try {
    await cleanup();
  } catch (error) {
    // error-policy:J6 best-effort teardown — a throwing cleanup must not block
    // the remaining services' teardown; it is reported, never swallowed.
    reportServiceError(host, instance.definition.id, error, "cleanup");
  }
}

function stopInstance(
  host: HostState,
  instance: ServiceInstance,
): Promise<void> {
  if (instance.stopPromise) return instance.stopPromise;

  let resolveStop!: () => void;
  let rejectStop!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  // Install the shared completion before abort(), whose listeners run
  // synchronously and may re-enter this stop path.
  instance.stopPromise = completion;
  const id = instance.definition.id;
  instance.status = "stopped";
  instance.controller.abort();
  // If acquisition already completed, invoke cleanup before returning from
  // the stop request so pagehide initiates native teardown in the same task.
  const eagerCleanup = instance.cleanup
    ? runCleanup(host, instance)
    : Promise.resolve();
  const stopping = (async () => {
    await eagerCleanup;
    // A pending start owns acquisition until it settles. Its abort branch
    // releases any cleanup returned after the stop request.
    await instance.startPromise;
    await runCleanup(host, instance);
    // Identity, not just id, prevents an old generation from deleting a
    // successor if future callers evolve independently of the host queue.
    if (host.instances.get(id) === instance) {
      host.instances.delete(id);
    }
  })();
  void stopping.then(resolveStop, rejectStop);
  return completion;
}

function startInstance(
  host: HostState,
  definition: RendererServiceDefinition,
  definitionVersion: number,
): ServiceInstance {
  const controller = new AbortController();
  const instance: ServiceInstance = {
    definition,
    definitionVersion,
    controller,
    status: "starting",
    cleanup: null,
    startPromise: Promise.resolve(),
    stopPromise: null,
  };
  host.instances.set(definition.id, instance);

  // Defer the call one microtask so startPromise is installed before service
  // code can synchronously trigger a replacement or stop through callbacks.
  instance.startPromise = Promise.resolve().then(async () => {
    if (controller.signal.aborted) return;
    let cleanup: RendererServiceCleanup;
    try {
      cleanup = await definition.start({
        shell: host.shell,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        // error-policy:J6 the instance was stopped while starting; a rejection
        // from the torn-down start is expected teardown noise, not a failure.
        return;
      }
      // The failed instance stays in the map so its state reads "failed", not
      // a healthy-looking absence (three-state rule: failure must be visible).
      instance.status = "failed";
      // error-policy:J1 host boundary — a service failing to start must not
      // take down the renderer boot path; it is surfaced via the reporter.
      reportServiceError(host, definition.id, error, "start");
      return;
    }

    if (typeof cleanup !== "function") {
      if (!controller.signal.aborted) instance.status = "failed";
      reportServiceError(
        host,
        definition.id,
        new Error(
          `renderer service "${definition.id}" start() returned ${String(
            cleanup,
          )} instead of a cleanup function`,
        ),
        "start",
      );
      return;
    }

    if (controller.signal.aborted) {
      // Stopped while start was awaited: run the late cleanup now so no
      // listener/interval installed by the finished start survives the stop.
      instance.cleanup = cleanup;
      await runCleanup(host, instance);
      return;
    }

    instance.cleanup = cleanup;
    instance.status = "running";
  });
  return instance;
}

function isEligible(
  definition: RendererServiceDefinition,
  shell: RendererShellKind,
): boolean {
  return definition.shells.includes(shell);
}

async function reconcileService(
  host: HostState,
  serviceId: string,
  expectedVersion?: number,
): Promise<void> {
  const store = getStore();
  const definition = store.definitions.get(serviceId);
  const definitionVersion = store.definitionVersions.get(serviceId);
  if (
    !definition ||
    definitionVersion === undefined ||
    (expectedVersion !== undefined && definitionVersion !== expectedVersion)
  ) {
    return;
  }

  const existing = host.instances.get(serviceId);
  if (existing?.definitionVersion === definitionVersion) {
    await existing.startPromise;
    return;
  }
  if (existing) await stopInstance(host, existing);

  // Every awaited boundary is followed by a freshness check. A registration,
  // host replacement, or bfcache suspension may have superseded this request
  // while the prior generation was releasing its resources.
  if (
    host.disposed ||
    host.suspended ||
    store.host !== host ||
    store.definitions.get(serviceId) !== definition ||
    store.definitionVersions.get(serviceId) !== definitionVersion ||
    !isEligible(definition, host.shell)
  ) {
    return;
  }

  const instance = startInstance(host, definition, definitionVersion);
  await instance.startPromise;
}

async function startEligibleServices(host: HostState): Promise<void> {
  if (host.disposed || host.suspended || getStore().host !== host) return;
  await Promise.all(
    [...getStore().definitions.keys()].map((serviceId) =>
      reconcileService(host, serviceId),
    ),
  );
}

/**
 * Register (or re-register) a renderer service definition. Plugin registration
 * entries call this at import time. If a host is active and the definition's
 * shells include the host's shell, the service is queued to start.
 * Re-registering an id aborts the old instance immediately and awaits its
 * cleanup before starting the latest definition. Multiple registrations that
 * arrive during cleanup coalesce to the newest generation.
 */
export function registerRendererService(
  definition: RendererServiceDefinition,
): void {
  if (!definition.id || definition.id.trim().length === 0) {
    throw new Error(`${LOG_PREFIX} a renderer service needs a non-empty id`);
  }
  if (definition.shells.length === 0) {
    throw new Error(
      `${LOG_PREFIX} service "${definition.id}" declares no shells; declare where it runs instead of registering it nowhere`,
    );
  }
  const store = getStore();
  const definitionVersion = store.nextDefinitionVersion + 1;
  store.nextDefinitionVersion = definitionVersion;
  store.definitions.set(definition.id, definition);
  store.definitionVersions.set(definition.id, definitionVersion);

  const host = store.host;
  if (!host || host.disposed || host.suspended) return;
  const existing = host.instances.get(definition.id);
  const stopped = existing ? stopInstance(host, existing) : Promise.resolve();
  void enqueueTransition(store, async () => {
    await stopped;
    await reconcileService(host, definition.id, definitionVersion);
  });
}

/**
 * Install the per-window service host. The app shell calls this once per
 * renderer window with the window's resolved shell kind; every already
 * registered eligible definition starts, later registrations start on arrival,
 * and `pagehide` stops external resources. A persisted bfcache transition keeps
 * the logical host but resumes services through a fresh generation on
 * `pageshow`; a real teardown disposes the host. Calling again aborts the
 * previous host immediately and queues the successor after all cleanup.
 */
export function startRendererServiceHost(options: {
  shell: RendererShellKind;
  reportError?: RendererServiceErrorReporter;
}): RendererServiceHostHandle {
  const store = getStore();
  if (store.host) void disposeHost(store.host);

  const host: HostState = {
    shell: options.shell,
    reportError: options.reportError ?? defaultReportError,
    instances: new Map(),
    detachPageEvents: null,
    disposed: false,
    suspended: false,
    disposePromise: null,
  };
  store.host = host;

  if (typeof window !== "undefined") {
    const onPagehide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void suspendHost(host);
      } else {
        void disposeHost(host);
      }
    };
    const onPageshow = (event: PageTransitionEvent) => {
      if (event.persisted) resumeHost(host);
    };
    window.addEventListener("pagehide", onPagehide);
    window.addEventListener("pageshow", onPageshow);
    host.detachPageEvents = () => {
      window.removeEventListener("pagehide", onPagehide);
      window.removeEventListener("pageshow", onPageshow);
    };
  }

  void enqueueTransition(store, () => startEligibleServices(host));

  return {
    shell: host.shell,
    dispose: () => disposeHost(host),
  };
}

function suspendHost(host: HostState): Promise<void> {
  const store = getStore();
  if (host.disposed || host.suspended || store.host !== host) {
    return store.transition;
  }
  host.suspended = true;
  const stops = [...host.instances.values()].map((instance) =>
    stopInstance(host, instance),
  );
  return enqueueTransition(store, async () => {
    await Promise.all(stops);
  });
}

function resumeHost(host: HostState): void {
  const store = getStore();
  if (host.disposed || !host.suspended || store.host !== host) return;
  host.suspended = false;
  void enqueueTransition(store, () => startEligibleServices(host));
}

function disposeHost(host: HostState): Promise<void> {
  if (host.disposePromise) return host.disposePromise;

  let resolveDisposal!: () => void;
  let rejectDisposal!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveDisposal = resolve;
    rejectDisposal = reject;
  });
  // Install the shared completion before abort(), whose listeners run
  // synchronously and may re-enter host disposal.
  host.disposePromise = completion;
  host.disposed = true;
  host.suspended = false;
  host.detachPageEvents?.();
  host.detachPageEvents = null;

  const store = getStore();
  if (store.host === host) store.host = null;
  const stops = [...host.instances.values()].map((instance) =>
    stopInstance(host, instance),
  );
  const transition = enqueueTransition(store, async () => {
    await Promise.all(stops);
  });
  void transition.then(resolveDisposal, rejectDisposal);
  return completion;
}

/**
 * Current registry snapshot for diagnostics and tests: every registered
 * definition with its lifecycle status under the active host (or
 * "registered"/"ineligible" when idle), plus the active host shell.
 */
export function getRendererServiceStates(): {
  hostShell: RendererShellKind | null;
  services: RendererServiceState[];
} {
  const store = getStore();
  const host = store.host && !store.host.disposed ? store.host : null;
  const services: RendererServiceState[] = [];
  for (const definition of store.definitions.values()) {
    const instance = host?.instances.get(definition.id);
    const status: RendererServiceStatus = instance
      ? instance.status
      : host
        ? isEligible(definition, host.shell)
          ? "stopped"
          : "ineligible"
        : "registered";
    services.push({ id: definition.id, shells: definition.shells, status });
  }
  return { hostShell: host?.shell ?? null, services };
}

/**
 * Wait for the ownership queue, including starts and asynchronous cleanup.
 * Diagnostics/tests only; production callers use the returned host handle.
 */
export async function settleRendererServices(): Promise<void> {
  const store = getStore();
  while (true) {
    const transition = store.transition;
    await transition;
    if (transition === store.transition) return;
  }
}

/**
 * Drop every definition and stop the active host. Test isolation only — the
 * store is process-global, so suites that exercise registration must reset it
 * between cases.
 */
export async function resetRendererServicesForTest(): Promise<void> {
  const store = getStore();
  store.definitions.clear();
  store.definitionVersions.clear();
  if (store.host) await disposeHost(store.host);
  await settleRendererServices();
  // Cleanup code is arbitrary service code and may register definitions.
  // Clear again only after teardown has fully settled for strict test isolation.
  store.definitions.clear();
  store.definitionVersions.clear();
  store.nextDefinitionVersion = 0;
}
