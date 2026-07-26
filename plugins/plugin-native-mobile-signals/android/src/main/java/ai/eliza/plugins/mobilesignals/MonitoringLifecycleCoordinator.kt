/**
 * Linearizes Android monitor, receiver, listener, and signal-publication
 * ownership across Capacitor's plugin thread and Android's activity thread.
 * Native resources remain retryable when their release postcondition is
 * uncertain, while callbacks are quarantined immediately.
 */
package ai.eliza.plugins.mobilesignals

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.joinAll

internal enum class MonitoringLifecycleState {
    IDLE,
    STARTING,
    ACTIVE,
    TEARDOWN_PENDING,
    DRAINING,
    DESTROYED,
}

internal data class MonitoringDrain(
    val jobs: List<Job> = emptyList(),
    val publications: List<Deferred<Unit>> = emptyList(),
) {
    suspend fun await() {
        jobs.joinAll()
        publications.awaitAll()
    }
}

internal class MonitoringReleaseException(
    message: String,
    val drain: MonitoringDrain,
    cause: Throwable,
) : Exception(message, cause)

internal class MonitoringStartException(
    message: String,
    val drain: MonitoringDrain,
    val stopTransition: MonitoringStopTransition?,
    cause: Throwable,
) : Exception(message, cause)

internal class SignalListenerReleaseException(
    message: String,
    val drain: MonitoringDrain,
    cause: Throwable,
) : Exception(message, cause)

internal data class SignalListenerRelease(
    val drain: MonitoringDrain,
    internal val generation: Long,
)

internal data class MonitoringStopTransition(
    val drain: MonitoringDrain,
    internal val generation: Long,
)

internal data class MonitoringDestroyResult(
    val drain: MonitoringDrain,
    val releaseError: Throwable?,
)

internal class MonitoringLifecycleCoordinator<Receiver : Any> {
    private val lock = Any()
    private val receiverOwnership = ReceiverOwnership<Receiver>()
    private val generations = MonitoringGeneration()
    private val jobs = MonitoringJobRegistry()
    private val publications = SignalPublicationRegistry()
    private var state = MonitoringLifecycleState.IDLE
    private var activeGeneration: Long? = null
    private var pendingMonitorStop: MonitoringStopTransition? = null
    private var monitorStopGeneration = 0L
    private var listenerReleaseInProgress = false
    private var listenerReleasePending = false
    private var listenerReleaseGeneration = 0L

    fun <Result> start(
        createCandidate: (generation: Long) -> Receiver,
        register: (Receiver) -> Unit,
        unregister: (Receiver) -> Unit,
        onReady: (generation: Long, newlyAcquired: Boolean) -> Result,
    ): Result = synchronized(lock) {
        check(state != MonitoringLifecycleState.DESTROYED) {
            "Cannot start monitoring after plugin destruction"
        }
        if (state == MonitoringLifecycleState.ACTIVE) {
            return@synchronized onReady(
                checkNotNull(activeGeneration),
                false,
            )
        }
        check(state != MonitoringLifecycleState.STARTING) {
            "A monitoring start transition is already in progress"
        }
        check(state != MonitoringLifecycleState.TEARDOWN_PENDING) {
            "Cannot start while monitoring receiver release is uncertain"
        }
        check(state != MonitoringLifecycleState.DRAINING) {
            "Cannot start until the prior monitoring generation has drained"
        }

        try {
            receiverOwnership.release(unregister)
        } catch (error: Throwable) {
            // error-policy:J2 an unexpected residual receiver is quarantined
            // and remains owned until Android confirms its absence.
            state = MonitoringLifecycleState.TEARDOWN_PENDING
            throw MonitoringReleaseException(
                "Residual monitoring receiver release is uncertain",
                quarantineLocked(),
                error,
            )
        }

        val generation = generations.begin()
        state = MonitoringLifecycleState.STARTING
        try {
            val candidate = createCandidate(generation)
            receiverOwnership.acquire(candidate, register)
            jobs.activate(generation)
            activeGeneration = generation
            state = MonitoringLifecycleState.ACTIVE
            onReady(generation, true)
        } catch (error: Throwable) {
            // error-policy:J2 rollback owns every resource acquired before the
            // failed start and retains an uncertain receiver for retry.
            val drain = quarantineLocked()
            var stopTransition: MonitoringStopTransition? = null
            try {
                receiverOwnership.release(unregister)
                stopTransition = beginMonitorDrainLocked(drain)
            } catch (cleanupError: Throwable) {
                // error-policy:J2 the start failure remains primary while the
                // suppressed cleanup failure explains retained ownership.
                state = MonitoringLifecycleState.TEARDOWN_PENDING
                error.addSuppressed(cleanupError)
            }
            throw MonitoringStartException(
                "Monitoring startup failed",
                drain,
                stopTransition,
                error,
            )
        }
    }

    fun stop(
        unregister: (Receiver) -> Unit,
    ): MonitoringStopTransition = synchronized(lock) {
        check(state != MonitoringLifecycleState.DESTROYED) {
            "Cannot stop monitoring after plugin destruction"
        }
        if (state == MonitoringLifecycleState.DRAINING) {
            return@synchronized checkNotNull(pendingMonitorStop)
        }
        val drain = quarantineLocked()
        try {
            receiverOwnership.release(unregister)
            beginMonitorDrainLocked(drain)
        } catch (error: Throwable) {
            // error-policy:J2 callbacks are quarantined even though receiver
            // ownership remains uncertain and retryable.
            state = MonitoringLifecycleState.TEARDOWN_PENDING
            throw MonitoringReleaseException(
                "Monitoring receiver release is uncertain",
                drain,
                error,
            )
        }
    }

    fun finishStop(stopTransition: MonitoringStopTransition): Boolean =
        synchronized(lock) {
            if (
                state == MonitoringLifecycleState.DRAINING &&
                pendingMonitorStop?.generation == stopTransition.generation
            ) {
                pendingMonitorStop = null
                state = MonitoringLifecycleState.IDLE
                true
            } else {
                false
            }
        }

    fun destroy(unregister: (Receiver) -> Unit): MonitoringDestroyResult = synchronized(lock) {
        val monitorDrain = quarantineLocked()
        val listenerPublications = publications.closeAdmission()
        listenerReleaseInProgress = false
        listenerReleaseGeneration += 1
        monitorStopGeneration += 1
        pendingMonitorStop = null
        state = MonitoringLifecycleState.DESTROYED
        var releaseError: Throwable? = null
        try {
            receiverOwnership.release(unregister)
        } catch (error: Throwable) {
            // error-policy:J6 destruction cannot retry in this plugin instance;
            // retained ownership stays observable while publication is disabled.
            releaseError = error
        }
        MonitoringDestroyResult(
            drain = MonitoringDrain(
                jobs = monitorDrain.jobs,
                publications = (monitorDrain.publications + listenerPublications).distinct(),
            ),
            releaseError = releaseError,
        )
    }

    fun acquireSignalPublication(generation: Long): SignalPublicationLease? =
        synchronized(lock) {
            if (!isActiveLocked(generation)) {
                null
            } else {
                publications.acquire()
            }
        }

    fun publishSignal(
        generation: Long,
        lease: SignalPublicationLease,
        publish: () -> Unit,
    ): Boolean = synchronized(lock) {
        if (!isActiveLocked(generation)) {
            false
        } else {
            publications.publishIfCurrent(lease) {
                publish()
                true
            } == true
        }
    }

    fun isActive(generation: Long): Boolean = synchronized(lock) {
        isActiveLocked(generation)
    }

    fun isActive(): Boolean = synchronized(lock) {
        val generation = activeGeneration
        generation != null && isActiveLocked(generation)
    }

    fun registerJob(job: Job, generation: Long): Boolean = synchronized(lock) {
        if (!isActiveLocked(generation) || !jobs.register(job, generation)) {
            false
        } else {
            job.invokeOnCompletion {
                jobs.complete(job)
            }
            true
        }
    }

    fun addSignalListener(add: () -> Unit) {
        synchronized(lock) {
            check(state != MonitoringLifecycleState.DESTROYED) {
                "Cannot add a signal listener after plugin destruction"
            }
            check(!listenerReleaseInProgress && !listenerReleasePending) {
                "Cannot add a signal listener while prior listener release is incomplete"
            }
            add()
            publications.openAdmission()
        }
    }

    fun removeSignalListener(
        remove: () -> Unit,
        hasListeners: () -> Boolean,
    ): MonitoringDrain = synchronized(lock) {
        remove()
        if (hasListeners()) {
            MonitoringDrain()
        } else {
            MonitoringDrain(publications = publications.closeAdmission())
        }
    }

    fun beginSignalListenerRelease(release: () -> Unit): SignalListenerRelease =
        synchronized(lock) {
            check(!listenerReleaseInProgress) {
                "Signal listener release is already in progress"
            }
            listenerReleaseInProgress = true
            listenerReleaseGeneration += 1
            val releaseGeneration = listenerReleaseGeneration
            val drain = MonitoringDrain(publications = publications.closeAdmission())
            try {
                release()
                listenerReleasePending = false
                SignalListenerRelease(drain, releaseGeneration)
            } catch (error: Throwable) {
                // error-policy:J2 failed bridge release remains retryable and
                // keeps listener admission closed.
                listenerReleaseInProgress = false
                listenerReleasePending = true
                throw SignalListenerReleaseException(
                    "Signal listener release is uncertain",
                    drain,
                    error,
                )
            }
        }

    fun finishSignalListenerRelease(release: SignalListenerRelease): Boolean =
        synchronized(lock) {
            if (
                listenerReleaseInProgress &&
                release.generation == listenerReleaseGeneration
            ) {
                listenerReleaseInProgress = false
                true
            } else {
                false
            }
        }

    fun resetSignalListeners(reset: () -> Unit) {
        synchronized(lock) {
            publications.closeAdmission()
            var released = false
            try {
                reset()
                released = true
            } finally {
                listenerReleaseGeneration += 1
                listenerReleaseInProgress = false
                listenerReleasePending = !released
            }
        }
    }

    fun state(): MonitoringLifecycleState = synchronized(lock) {
        state
    }

    fun hasReceiverOwnership(): Boolean = synchronized(lock) {
        receiverOwnership.hasOwnership()
    }

    fun hasPendingListenerRelease(): Boolean = synchronized(lock) {
        listenerReleaseInProgress || listenerReleasePending
    }

    private fun quarantineLocked(): MonitoringDrain {
        state = MonitoringLifecycleState.TEARDOWN_PENDING
        activeGeneration = null
        pendingMonitorStop = null
        generations.invalidate()
        return MonitoringDrain(
            jobs = jobs.invalidate(),
            publications = publications.pending(),
        )
    }

    private fun beginMonitorDrainLocked(
        drain: MonitoringDrain,
    ): MonitoringStopTransition {
        monitorStopGeneration += 1
        return MonitoringStopTransition(
            drain,
            monitorStopGeneration,
        ).also { stopTransition ->
            pendingMonitorStop = stopTransition
            state = MonitoringLifecycleState.DRAINING
        }
    }

    private fun isActiveLocked(generation: Long): Boolean {
        return state == MonitoringLifecycleState.ACTIVE &&
            activeGeneration == generation &&
            generations.isCurrent(generation) &&
            jobs.isActive(generation)
    }
}
