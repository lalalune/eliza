/**
 * Pins the atomic registration/cancellation boundary for Android monitoring
 * coroutines without relying on scheduler timing.
 */
package ai.eliza.plugins.mobilesignals

import kotlinx.coroutines.Job
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitoringJobRegistryTest {
    @Test
    fun `invalidate cancels every owned job and rejects the stopped generation`() {
        val registry = MonitoringJobRegistry()
        val owned = Job()
        val late = Job()
        registry.activate(3)
        assertTrue(registry.register(owned, 3))

        val cancelled = registry.invalidate()

        assertSame(owned, cancelled.single())
        assertTrue(owned.isCancelled)
        assertFalse(registry.register(late, 3))
    }

    @Test
    fun `successor accepts only its own generation`() {
        val registry = MonitoringJobRegistry()
        registry.activate(5)
        registry.invalidate()
        registry.activate(6)

        assertFalse(registry.register(Job(), 5))
        assertTrue(registry.register(Job(), 6))
    }

    @Test
    fun `completed jobs are not retained for teardown`() {
        val registry = MonitoringJobRegistry()
        val completed = Job()
        registry.activate(9)
        assertTrue(registry.register(completed, 9))

        registry.complete(completed)

        assertTrue(registry.invalidate().isEmpty())
    }
}
