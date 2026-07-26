/**
 * Verifies the Android receiver-release policy without substituting a fake
 * success for failures whose postcondition is unknown.
 */
package ai.eliza.plugins.mobilesignals

import org.junit.Assert.assertSame
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MobileSignalsReceiverReleasePolicyTest {
    @Test
    fun `successful unregister establishes the stopped postcondition`() {
        var calls = 0

        unregisterReceiverOrConfirmAbsent {
            calls += 1
        }

        org.junit.Assert.assertEquals(1, calls)
    }

    @Test
    fun `already-unregistered receiver establishes the stopped postcondition`() {
        unregisterReceiverOrConfirmAbsent {
            throw IllegalArgumentException("Receiver not registered")
        }
    }

    @Test
    fun `unknown unregister failure propagates instead of reporting stopped`() {
        val failure = SecurityException("unregister denied")

        try {
            unregisterReceiverOrConfirmAbsent {
                throw failure
            }
            fail("SecurityException should propagate")
        } catch (error: SecurityException) {
            assertSame(failure, error)
        }
    }

    @Test
    fun `failed rollback retains ownership and blocks overwrite until retry confirms release`() {
        val ownership = ReceiverOwnership<Any>()
        val first = Any()
        val successor = Any()
        ownership.acquire(first) {}

        try {
            ownership.release {
                throw SecurityException("unregister denied")
            }
            fail("Unknown rollback failure should propagate")
        } catch (_: SecurityException) {
            assertTrue(ownership.owns(first))
        }

        var successorRegistered = false
        try {
            ownership.acquire(successor) {
                successorRegistered = true
            }
            fail("Successor must not overwrite residual receiver ownership")
        } catch (_: IllegalStateException) {
            assertFalse(successorRegistered)
            assertTrue(ownership.owns(first))
        }

        ownership.release {
            assertSame(first, it)
        }
        ownership.acquire(successor) {
            successorRegistered = true
        }

        assertTrue(successorRegistered)
        assertTrue(ownership.owns(successor))
    }

    @Test
    fun `ambiguous registration failure is owned until absence is confirmed`() {
        val ownership = ReceiverOwnership<Any>()
        val candidate = Any()
        val failure = SecurityException("registration failed after crossing native boundary")

        try {
            ownership.acquire(candidate) {
                throw failure
            }
            fail("Registration failure should propagate")
        } catch (error: SecurityException) {
            assertSame(failure, error)
            assertTrue(ownership.owns(candidate))
        }

        ownership.release {
            unregisterReceiverOrConfirmAbsent {
                throw IllegalArgumentException("Receiver not registered")
            }
        }

        assertFalse(ownership.owns(candidate))
    }

    @Test
    fun `failed start invalidates jobs and generation while residual receiver stays owned`() {
        val ownership = ReceiverOwnership<Any>()
        val generations = MonitoringGeneration()
        val jobs = MonitoringJobRegistry()
        val receiver = Any()
        val job = kotlinx.coroutines.Job()
        val generation = generations.begin()
        ownership.acquire(receiver) {}
        jobs.activate(generation)
        assertTrue(jobs.register(job, generation))

        generations.invalidate()
        jobs.invalidate()
        try {
            ownership.release {
                throw SecurityException("rollback failed")
            }
            fail("Rollback failure should propagate")
        } catch (_: SecurityException) {
            assertFalse(generations.isCurrent(generation))
            assertFalse(jobs.isActive(generation))
            assertTrue(job.isCancelled)
            assertTrue(ownership.owns(receiver))
        }
    }
}
