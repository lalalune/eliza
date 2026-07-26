/**
 * Pins generation invalidation across stop and immediate restart without
 * substituting a timing-dependent coroutine scheduler.
 */
package ai.eliza.plugins.mobilesignals

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitoringGenerationTest {
    @Test
    fun `a completion from the stopped generation cannot enter its successor`() {
        val generations = MonitoringGeneration()
        val first = generations.begin()
        assertTrue(generations.isCurrent(first))

        generations.invalidate()
        val second = generations.begin()

        assertFalse(generations.isCurrent(first))
        assertTrue(generations.isCurrent(second))
    }
}
