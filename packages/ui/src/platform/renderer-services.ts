/**
 * Owns long-lived renderer work such as pollers, native listeners, and capture
 * loops so plugins cannot orphan resources outside React.
 *
 * Plugin registration entries declare shell-scoped definitions; the app shell
 * installs one host per renderer window. The host retains cleanup ownership on
 * suspension, teardown, host replacement, and HMR re-registration. Cleanup
 * waits are bounded so one broken service cannot deadlock unrelated work; a
 * timed-out lease stays quarantined and blocks only that service's successor.
 * Registration order does not matter, and rapid replacements coalesce to the
 * latest generation.
 *
 * A `globalThis` store preserves single ownership across duplicated module
 * evaluations. Stops abort pending starts immediately and observe late cleanup
 * through the same bounded ownership policy. Persisted `pagehide` suspends
 * external resources; `pageshow` starts a fresh serialized generation. Missing
 * cleanup is a contract failure (#16504, #17110).
 */
import { ElizaError } from "@elizaos/core";

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

/**
 * Releases every resource acquired by a service. Cleanup must be idempotent
 * and retry-safe: the host serializes attempts, but retries a rejected release
 * because a successor cannot safely start until ownership is proved absent.
 */
export type RendererServiceCleanup = () => void | Promise<void>;

export interface RendererServiceDefinition {
  /** Globally unique, stable id, e.g. "personal-assistant.lifeops-activity-signals". */
  id: string;
  /** Shell kinds this service is allowed to run in. */
  shells: readonly RendererShellKind[];
  /**
   * Start the service. Must return (or resolve to) the cleanup that undoes
   * every listener/interval/native handle it installed. May be async; when a
   * stopped start returns ownership late, the host invokes that cleanup and
   * quarantines the id if release does not settle within the ownership bound.
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
) => void | Promise<void>;

export interface RendererServiceHostHandle {
  shell: RendererShellKind;
  /**
   * Stop every running/starting instance. Resolution means each release either
   * settled or reached the ownership bound and remains visibly quarantined.
   */
  dispose: () => Promise<void>;
}

interface ServiceInstance {
  definition: RendererServiceDefinition;
  definitionVersion: number;
  /** Invalidates late continuations after the test-only registry reset. */
  storeEpoch: number;
  controller: AbortController;
  status: "starting" | "running" | "failed" | "stopped";
  cleanup: RendererServiceCleanup | null;
  /** Settles after bounded start handling; a timed-out outcome stays observed. */
  startPromise: Promise<void>;
  /** Shared by concurrent stop callers for one serialized release attempt. */
  stopPromise: Promise<void> | null;
  /** A rejected cleanup leaves ownership uncertain and blocks successors. */
  cleanupFailed: boolean;
  /** Schema-v1 completion promise consumed during an in-place HMR upgrade. */
  settled?: Promise<void>;
  /** Legacy starting work could discard an async cleanup and cannot recover. */
  legacyStartUntrackable?: boolean;
}

interface HostState {
  shell: RendererShellKind;
  reportError: RendererServiceErrorReporter;
  instances: Map<string, ServiceInstance>;
  detachPageEvents: (() => void) | null;
  /** Schema-v1 pagehide disposer consumed during an in-place HMR upgrade. */
  detachPagehide?: (() => void) | null;
  disposed: boolean;
  suspended: boolean;
  disposePromise: Promise<void> | null;
}

interface CleanupRetryState {
  cleanup: RendererServiceCleanup;
  activeAttempt: Promise<void> | null;
  /** A timed-out attempt remains the sole owner until it eventually settles. */
  timedOutAttempt: Promise<void> | null;
  /** Prevents repeated diagnostics when several reconciles see one hung call. */
  reportedAttempt: Promise<void> | null;
}

interface RendererServiceStore {
  epoch: number;
  definitions: Map<string, RendererServiceDefinition>;
  definitionVersions: Map<string, number>;
  nextDefinitionVersion: number;
  /** Services whose prior generation could not prove complete release. */
  blockedServiceIds: Set<string>;
  /** Retryable cleanup leases retained after rejection or timeout. */
  cleanupRetries: Map<string, CleanupRetryState>;
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
      epoch: 0,
      definitions: new Map(),
      definitionVersions: new Map(),
      nextDefinitionVersion: 0,
      blockedServiceIds: new Set(),
      cleanupRetries: new Map(),
      host: null,
      transition: Promise.resolve(),
    };
  }
  const store = holder[STORE_KEY];

  // HMR deliberately preserves this global store across module evaluations.
  // Cached schema-v1 hosts may own live services, so migration preserves their
  // instances while installing serialized lifecycle ownership.
  store.epoch ??= 0;
  store.definitionVersions ??= new Map();
  store.nextDefinitionVersion ??= 0;
  store.blockedServiceIds ??= new Set();
  store.cleanupRetries ??= new Map();
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
    if (host.detachPagehide) {
      const detachLegacyPagehide = host.detachPagehide;
      const detachCurrentPageEvents = host.detachPageEvents;
      detachLegacyPagehide();
      if (
        detachCurrentPageEvents &&
        detachCurrentPageEvents !== detachLegacyPagehide
      ) {
        detachCurrentPageEvents();
      }
      host.detachPagehide = null;
      host.detachPageEvents = null;
      attachPageEvents(host);
    }
    for (const [id, instance] of host.instances) {
      instance.definitionVersion ??= store.definitionVersions.get(id) ?? 0;
      instance.storeEpoch ??= store.epoch;
      if (!instance.startPromise) {
        const legacySettled = instance.settled ?? Promise.resolve();
        if (instance.status === "starting") {
          // Schema-v1 did not retain the Promise returned by a cleanup acquired
          // after abort. Migration cannot recover that lease, so this id stays
          // quarantined until a document reload establishes a new boundary.
          instance.controller.abort();
          instance.status = "failed";
          instance.legacyStartUntrackable = true;
          store.blockedServiceIds.add(id);
          reportServiceError(
            host,
            id,
            new ElizaError(
              `renderer service "${id}" was starting under an untrackable legacy lifecycle`,
              {
                code: "RENDERER_SERVICE_LEGACY_OWNERSHIP_UNTRACKABLE",
                context: { serviceId: id },
                severity: "fatal",
              },
            ),
            "start",
          );
        }
        instance.startPromise = awaitOwnershipSettlement(
          Promise.resolve(legacySettled),
          id,
          "start",
        ).catch((error) => {
          // error-policy:J1 the HMR upgrade boundary translates an old
          // lifecycle rejection into the current failed/quarantined state.
          instance.status = "failed";
          store.blockedServiceIds.add(id);
          reportServiceError(host, id, error, "start");
        });
      }
      instance.stopPromise ??= null;
      instance.cleanupFailed ??= false;
      instance.legacyStartUntrackable ??= false;
    }
  }
  return store;
}

const LOG_PREFIX = "[RendererServices]";
const OWNERSHIP_SETTLE_TIMEOUT_MS = 10_000;

class OwnershipSettlementTimeoutError extends ElizaError {
  constructor(serviceId: string, phase: "start" | "cleanup") {
    super(
      `renderer service "${serviceId}" ${phase} did not settle within ${OWNERSHIP_SETTLE_TIMEOUT_MS}ms`,
      {
        code: "RENDERER_SERVICE_OWNERSHIP_TIMEOUT",
        context: {
          serviceId,
          phase,
          timeoutMs: OWNERSHIP_SETTLE_TIMEOUT_MS,
        },
        severity: "ephemeral",
      },
    );
  }
}

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
    const reporting = host.reportError(serviceId, error, phase);
    if (reporting) {
      // error-policy:J7 reporter diagnostics must never create an unhandled
      // rejection or become part of the resource-ownership queue.
      void reporting.catch((reporterError) => {
        defaultReportError(
          serviceId,
          new AggregateError(
            [error, reporterError],
            `renderer service error reporter failed during ${phase}`,
          ),
          phase,
        );
      });
    }
  } catch (reporterError) {
    // error-policy:J7 reporter diagnostics must not kill lifecycle progress.
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
  // The second arm also handles a rejected transition imported from a cached
  // schema-v1 store. The returned promise preserves failure for its direct
  // caller, while the stored tail observes it and stays usable.
  const scheduled = store.transition.then(transition, (error) => {
    defaultReportError("renderer-service-registry", error, "cleanup");
    return transition();
  });
  // error-policy:J5 direct callers observe `scheduled`; this second observer
  // reports the same failure and keeps the shared queue tail usable.
  store.transition = scheduled.catch((error) => {
    defaultReportError("renderer-service-registry", error, "cleanup");
  });
  return scheduled;
}

function ownershipTimeout(
  serviceId: string,
  phase: "start" | "cleanup",
): OwnershipSettlementTimeoutError {
  return new OwnershipSettlementTimeoutError(serviceId, phase);
}

async function awaitOwnershipSettlement<T>(
  promise: Promise<T>,
  serviceId: string,
  phase: "start" | "cleanup",
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(ownershipTimeout(serviceId, phase)),
          OWNERSHIP_SETTLE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function getOrStartCleanupAttempt(
  store: RendererServiceStore,
  serviceId: string,
  retry: CleanupRetryState,
): Promise<void> {
  if (retry.activeAttempt) return retry.activeAttempt;

  let result: void | Promise<void>;
  try {
    // Invoke synchronously so pagehide queues native release before the
    // browser is allowed to freeze the document.
    result = retry.cleanup();
  } catch (error) {
    // error-policy:J1 normalize a synchronous service-boundary throw into the
    // same observed attempt used for asynchronous cleanup rejection.
    result = Promise.reject(error);
  }
  const attempt = Promise.resolve(result);
  retry.activeAttempt = attempt;
  retry.timedOutAttempt = null;
  void attempt.then(
    () => {
      if (
        store.cleanupRetries.get(serviceId) === retry &&
        retry.activeAttempt === attempt
      ) {
        retry.activeAttempt = null;
        retry.timedOutAttempt = null;
        store.cleanupRetries.delete(serviceId);
        store.blockedServiceIds.delete(serviceId);
        queueReconcileAfterCleanupSettlement(store, serviceId);
      }
    },
    () => {
      if (
        store.cleanupRetries.get(serviceId) === retry &&
        retry.activeAttempt === attempt
      ) {
        const settledAfterTimeout = retry.timedOutAttempt === attempt;
        retry.activeAttempt = null;
        retry.timedOutAttempt = null;
        if (settledAfterTimeout) {
          // A late rejection makes this lease retryable again. Queue exactly
          // one retry; an immediate second rejection does not recursively
          // spin because that attempt was never marked timed out.
          queueReconcileAfterCleanupSettlement(store, serviceId);
        }
      }
    },
  );
  return attempt;
}

function queueReconcileAfterCleanupSettlement(
  store: RendererServiceStore,
  serviceId: string,
): void {
  const host = store.host;
  if (!host || host.disposed || host.suspended) return;
  // A release may settle after its bounded waiter returned. Queue the latest
  // definition now; requiring another HMR/pageshow event would turn a
  // transient slow teardown into a permanent stopped state.
  void enqueueTransition(store, () => reconcileService(host, serviceId));
}

async function settleCleanupRetry(
  host: HostState,
  serviceId: string,
  retry: CleanupRetryState,
): Promise<boolean> {
  const store = getStore();
  if (
    store.cleanupRetries.get(serviceId) !== retry ||
    !store.blockedServiceIds.has(serviceId)
  ) {
    return true;
  }
  if (retry.activeAttempt && retry.timedOutAttempt === retry.activeAttempt) {
    return false;
  }

  const attempt = getOrStartCleanupAttempt(store, serviceId, retry);
  try {
    await awaitOwnershipSettlement(attempt, serviceId, "cleanup");
    return true;
  } catch (error) {
    if (
      retry.activeAttempt === attempt &&
      error instanceof OwnershipSettlementTimeoutError
    ) {
      retry.timedOutAttempt = attempt;
    }
    if (retry.reportedAttempt !== attempt) {
      retry.reportedAttempt = attempt;
      // error-policy:J6 best-effort teardown — every other service still
      // tears down. This id stays quarantined until the same release lease
      // succeeds, so uncertain ownership cannot overlap a successor.
      reportServiceError(host, serviceId, error, "cleanup");
    }
    return false;
  }
}

async function runCleanup(
  host: HostState,
  instance: ServiceInstance,
): Promise<void> {
  const cleanup = instance.cleanup;
  if (!cleanup) return;

  const store = getStore();
  const serviceId = instance.definition.id;
  if (instance.storeEpoch !== store.epoch) {
    // A reset invalidates old continuations but cannot cancel arbitrary
    // service code. Release a late lease locally without letting it mutate
    // the fresh registry's block/retry state for a reused id.
    instance.cleanup = null;
    let result: void | Promise<void>;
    try {
      result = cleanup();
    } catch (error) {
      // error-policy:J1 normalize a synchronous service-boundary throw into
      // the stale generation's bounded asynchronous cleanup path.
      result = Promise.reject(error);
    }
    try {
      await awaitOwnershipSettlement(
        Promise.resolve(result),
        serviceId,
        "cleanup",
      );
    } catch (error) {
      // error-policy:J6 stale test-epoch teardown is observed but cannot
      // quarantine an unrelated generation in the replacement registry.
      reportServiceError(host, serviceId, error, "cleanup");
    }
    return;
  }

  let retry = store.cleanupRetries.get(serviceId);
  if (!retry) {
    retry = {
      cleanup,
      activeAttempt: null,
      timedOutAttempt: null,
      reportedAttempt: null,
    };
    store.cleanupRetries.set(serviceId, retry);
  }
  // The retry state, not the stopped instance, owns this lease from here.
  // Clearing before invocation prevents a successful attempt's recovery
  // reconcile from seeing and executing the same cleanup a second time.
  instance.cleanup = null;
  store.blockedServiceIds.add(serviceId);
  const released = await settleCleanupRetry(host, serviceId, retry);
  if (released) {
    instance.cleanupFailed = false;
  } else {
    instance.cleanupFailed = true;
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
  const hadRetainedCleanup = instance.cleanup !== null;
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
    // A failed release stays recorded for the next serialized reconcile.
    // Re-invoking it twice inside one stop would turn a retry policy into a
    // hot loop and offers no new boundary at which ownership could change.
    if (!instance.cleanupFailed) {
      await runCleanup(host, instance);
    }
    const store = getStore();
    if (
      instance.storeEpoch === store.epoch &&
      instance.settled &&
      hadRetainedCleanup &&
      !instance.legacyStartUntrackable &&
      !instance.cleanupFailed &&
      !store.cleanupRetries.has(id)
    ) {
      // A rejected schema-v1 `settled` may only reflect its reporter path.
      // Successful release of the cleanup it retained proves ownership absent.
      store.blockedServiceIds.delete(id);
    }
    // Identity, not just id, prevents an old generation from deleting a
    // successor if future callers evolve independently of the host queue.
    if (host.instances.get(id) === instance) {
      host.instances.delete(id);
    }
  })();
  void stopping.then(resolveStop, rejectStop);
  return completion;
}

type StartOutcome =
  | { status: "fulfilled"; cleanup: RendererServiceCleanup }
  | { status: "rejected"; error: unknown }
  | { status: "skipped" };

async function applyStartOutcome(
  host: HostState,
  instance: ServiceInstance,
  outcome: StartOutcome,
): Promise<void> {
  const { definition, controller } = instance;
  const store = getStore();
  const isCurrentEpoch = instance.storeEpoch === store.epoch;
  if (outcome.status === "skipped") return;
  if (outcome.status === "rejected") {
    instance.status = "failed";
    if (isCurrentEpoch) {
      store.blockedServiceIds.add(definition.id);
    }
    // error-policy:J1 host boundary — a service failing to start must not take
    // down renderer boot; uncertain partial acquisition stays quarantined.
    reportServiceError(host, definition.id, outcome.error, "start");
    return;
  }

  const cleanup = outcome.cleanup;
  if (typeof cleanup !== "function") {
    instance.status = "failed";
    if (isCurrentEpoch) {
      store.blockedServiceIds.add(definition.id);
    }
    reportServiceError(
      host,
      definition.id,
      new ElizaError(
        `renderer service "${definition.id}" start() returned ${String(
          cleanup,
        )} instead of a cleanup function`,
        {
          code: "RENDERER_SERVICE_INVALID_CLEANUP",
          context: { serviceId: definition.id },
          severity: "fatal",
        },
      ),
      "start",
    );
    return;
  }

  if (
    !isCurrentEpoch ||
    controller.signal.aborted ||
    instance.status === "failed"
  ) {
    // Stopped or timed out while start was awaited: release a cleanup returned
    // late. The id remains quarantined unless that release proves success.
    instance.cleanup = cleanup;
    await runCleanup(host, instance);
    return;
  }

  instance.cleanup = cleanup;
  instance.status = "running";
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
    storeEpoch: getStore().epoch,
    controller,
    status: "starting",
    cleanup: null,
    startPromise: Promise.resolve(),
    stopPromise: null,
    cleanupFailed: false,
    legacyStartUntrackable: false,
  };
  host.instances.set(definition.id, instance);

  // Defer the call one microtask so startPromise is installed before service
  // code can synchronously trigger a replacement or stop through callbacks.
  const outcome = Promise.resolve().then<StartOutcome>(async () => {
    if (controller.signal.aborted) {
      return { status: "skipped" };
    }
    try {
      const cleanup = await definition.start({
        shell: host.shell,
        signal: controller.signal,
      });
      return { status: "fulfilled", cleanup };
    } catch (error) {
      // error-policy:J1 the service start boundary translates arbitrary plugin
      // failures into an explicit lifecycle outcome for quarantine/reporting.
      return { status: "rejected", error };
    }
  });

  instance.startPromise = (async () => {
    let settled: StartOutcome;
    try {
      settled = await awaitOwnershipSettlement(outcome, definition.id, "start");
    } catch (error) {
      // error-policy:J1 the host boundary quarantines timed-out acquisition
      // while observing the underlying start for any late-owned cleanup.
      instance.status = "failed";
      getStore().blockedServiceIds.add(definition.id);
      controller.abort();
      reportServiceError(host, definition.id, error, "start");
      // The underlying call remains observed. If it returns ownership after
      // the bound, release it without letting the global queue wait forever.
      void outcome.then((lateOutcome) =>
        applyStartOutcome(host, instance, lateOutcome),
      );
      return;
    }
    await applyStartOutcome(host, instance, settled);
  })();
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
  if (store.blockedServiceIds.has(serviceId)) {
    const retry = store.cleanupRetries.get(serviceId);
    if (!retry || !(await settleCleanupRetry(host, serviceId, retry))) {
      return;
    }
  }

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
  if (
    existing?.definitionVersion === definitionVersion &&
    (existing.status === "starting" || existing.status === "running")
  ) {
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
    store.blockedServiceIds.has(serviceId) ||
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
    throw new ElizaError(
      `${LOG_PREFIX} a renderer service needs a non-empty id`,
      {
        code: "RENDERER_SERVICE_INVALID_DEFINITION",
        context: { reason: "empty_id" },
        severity: "fatal",
      },
    );
  }
  if (definition.shells.length === 0) {
    throw new ElizaError(
      `${LOG_PREFIX} service "${definition.id}" declares no shells; declare where it runs instead of registering it nowhere`,
      {
        code: "RENDERER_SERVICE_INVALID_DEFINITION",
        context: { serviceId: definition.id, reason: "empty_shells" },
        severity: "fatal",
      },
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

function attachPageEvents(host: HostState): void {
  if (typeof window === "undefined") return;

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

/**
 * Install the per-window service host. The app shell calls this once per
 * renderer window with the window's resolved shell kind; every already
 * registered eligible definition starts, later registrations start on arrival,
 * and `pagehide` stops external resources. A persisted bfcache transition keeps
 * the logical host but resumes services through a fresh generation on
 * `pageshow`; a real teardown disposes the host. Calling again aborts the
 * previous host immediately. Each successor waits for proved release of its
 * own id; a timed-out id remains quarantined without blocking unrelated work.
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
  attachPageEvents(host);

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
    const status: RendererServiceStatus = store.blockedServiceIds.has(
      definition.id,
    )
      ? "failed"
      : instance
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
 * Wait for the ownership queue, including bounded waits for starts and cleanup.
 * A resolved wait may leave a timed-out service quarantined; diagnostics/tests
 * can inspect that state without letting one broken lease deadlock the queue.
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
  store.blockedServiceIds.clear();
  store.cleanupRetries.clear();
  if (store.host) await disposeHost(store.host);
  await settleRendererServices();
  store.epoch += 1;
  // Cleanup code is arbitrary service code and may register definitions.
  // Clear again after the bounded teardown queue drains; the epoch keeps any
  // still-late test continuation from mutating the replacement registry.
  store.definitions.clear();
  store.definitionVersions.clear();
  store.blockedServiceIds.clear();
  store.cleanupRetries.clear();
  store.nextDefinitionVersion = 0;
}
