/**
 * Pins saved-callback ownership across normal removal, bulk release, and a
 * partially failed bridge release.
 */
package ai.eliza.plugins.mobilesignals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class NativeListenerCallRegistryTest {
    @Test
    fun `normal removal forgets the callback`() {
        val registry = NativeListenerCallRegistry<String>()
        registry.track("callback-1", "first")

        registry.forget("callback-1")

        assertTrue(registry.isEmpty())
    }

    @Test
    fun `bulk release visits every saved callback exactly once`() {
        val registry = NativeListenerCallRegistry<String>()
        val released = mutableListOf<String>()
        registry.track("callback-1", "first")
        registry.track("callback-2", "second")

        registry.releaseAll(released::add)
        registry.releaseAll(released::add)

        assertEquals(listOf("first", "second"), released)
        assertTrue(registry.isEmpty())
    }

    @Test
    fun `failed bulk release retains the failed callback for retry`() {
        val registry = NativeListenerCallRegistry<String>()
        val released = mutableListOf<String>()
        registry.track("callback-1", "first")
        registry.track("callback-2", "second")

        assertThrows(IllegalStateException::class.java) {
            registry.releaseAll { call ->
                if (call == "second") error("bridge release failed")
                released.add(call)
            }
        }

        assertEquals(listOf("first"), released)
        assertFalse(registry.isEmpty())
        registry.releaseAll(released::add)
        assertEquals(listOf("first", "second"), released)
        assertTrue(registry.isEmpty())
    }

    @Test
    fun `bridge reset transfers callbacks to its handler cleanup fence`() {
        val registry = NativeListenerCallRegistry<String>()
        registry.track("callback-1", "first")
        registry.track("callback-2", "second")

        assertEquals(listOf("first", "second"), registry.snapshot())
        val retained = registry.takeAll()

        assertEquals(listOf("first", "second"), retained)
        assertTrue(registry.isEmpty())
    }
}
