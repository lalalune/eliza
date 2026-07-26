/**
 * Pins listener-generation admission and draining without relying on Android or
 * coroutine scheduler timing.
 */
package ai.eliza.plugins.mobilesignals

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SignalPublicationRegistryTest {
    @Test
    fun `closed admission rejects publication ownership`() {
        val registry = SignalPublicationRegistry()

        assertNull(registry.acquire())
        assertFalse(registry.isAdmissionOpen())
    }

    @Test
    fun `closing admission invalidates and drains an admitted publication`() {
        val registry = SignalPublicationRegistry()
        registry.openAdmission()
        val lease = requireNotNull(registry.acquire())
        val drain = registry.closeAdmission()
        var published = false

        assertFalse(drain.single().isCompleted)
        assertNull(
            registry.publishIfCurrent(lease) {
                published = true
            },
        )
        assertFalse(published)

        lease.close()
        assertTrue(drain.single().isCompleted)
    }

    @Test
    fun `old generation cannot publish into reopened listener admission`() {
        val registry = SignalPublicationRegistry()
        registry.openAdmission()
        val old = requireNotNull(registry.acquire())
        registry.closeAdmission()
        registry.openAdmission()
        val current = requireNotNull(registry.acquire())
        var oldPublished = false
        var currentPublished = false

        registry.publishIfCurrent(old) {
            oldPublished = true
        }
        registry.publishIfCurrent(current) {
            currentPublished = true
        }

        assertFalse(oldPublished)
        assertTrue(currentPublished)
        old.close()
        current.close()
    }

    @Test
    fun `lease completion is idempotent`() {
        val registry = SignalPublicationRegistry()
        registry.openAdmission()
        val lease = requireNotNull(registry.acquire())
        val completion = registry.pending().single()

        lease.close()
        lease.close()

        assertTrue(completion.isCompleted)
        assertTrue(registry.pending().isEmpty())
    }
}
