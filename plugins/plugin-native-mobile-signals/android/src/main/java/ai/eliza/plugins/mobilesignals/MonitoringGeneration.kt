/**
 * Monotonic ownership token for asynchronous native monitoring work.
 *
 * A completion may publish only while its captured generation is current, so
 * stopping and restarting cannot make an old coroutine look active again.
 */
package ai.eliza.plugins.mobilesignals

import java.util.concurrent.atomic.AtomicLong

internal class MonitoringGeneration {
    private val current = AtomicLong(0)

    fun begin(): Long = current.incrementAndGet()

    fun invalidate(): Long = current.incrementAndGet()

    fun isCurrent(generation: Long): Boolean = current.get() == generation
}
