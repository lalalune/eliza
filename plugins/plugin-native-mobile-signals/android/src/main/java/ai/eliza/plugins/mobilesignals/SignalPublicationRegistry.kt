/**
 * Fences signal publication across listener generations and exposes admitted
 * work as drainable leases. Closing admission invalidates old work even if a
 * successor renderer installs listeners before that work finishes.
 */
package ai.eliza.plugins.mobilesignals

import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred

internal class SignalPublicationLease internal constructor(
    private val registry: SignalPublicationRegistry,
    internal val generation: Long,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    internal val completion = CompletableDeferred<Unit>()

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            registry.complete(this)
        }
    }
}

internal class SignalPublicationRegistry {
    private val lock = Any()
    private var admissionOpen = false
    private var generation = 0L
    private val leases = linkedSetOf<SignalPublicationLease>()

    fun openAdmission() {
        synchronized(lock) {
            if (!admissionOpen) {
                generation += 1
                admissionOpen = true
            }
        }
    }

    fun acquire(): SignalPublicationLease? = synchronized(lock) {
        if (!admissionOpen) {
            null
        } else {
            SignalPublicationLease(this, generation).also(leases::add)
        }
    }

    fun <Result> publishIfCurrent(
        lease: SignalPublicationLease,
        publish: () -> Result,
    ): Result? = synchronized(lock) {
        if (
            admissionOpen &&
            lease.generation == generation &&
            leases.contains(lease)
        ) {
            publish()
        } else {
            null
        }
    }

    fun closeAdmission(): List<Deferred<Unit>> = synchronized(lock) {
        if (admissionOpen) {
            admissionOpen = false
            generation += 1
        }
        leases.map { it.completion }
    }

    fun pending(): List<Deferred<Unit>> = synchronized(lock) {
        leases.map { it.completion }
    }

    fun isAdmissionOpen(): Boolean = synchronized(lock) {
        admissionOpen
    }

    internal fun complete(lease: SignalPublicationLease) {
        synchronized(lock) {
            if (leases.remove(lease)) {
                lease.completion.complete(Unit)
            }
        }
    }
}
