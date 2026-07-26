/**
 * Exercises Android monitoring as an ownership state machine, including
 * teardown failure, destruction races, callback drains, and listener epochs.
 */
package ai.eliza.plugins.mobilesignals

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitoringLifecycleCoordinatorTest {
    @Test
    fun `failed stop quarantines callbacks and blocks start until stop retry succeeds`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val receiver = Any()
        val generation = start(coordinator, receiver)
        val job = Job()
        assertTrue(coordinator.registerJob(job, generation))
        val publication =
            requireNotNull(coordinator.acquireSignalPublication(generation))
        val releaseFailure = SecurityException("unregister denied")

        val failure = assertThrows(MonitoringReleaseException::class.java) {
            coordinator.stop {
                throw releaseFailure
            }
        }

        assertSame(releaseFailure, failure.cause)
        assertEquals(
            MonitoringLifecycleState.TEARDOWN_PENDING,
            coordinator.state(),
        )
        assertFalse(coordinator.isActive(generation))
        assertTrue(job.isCancelled)
        assertTrue(coordinator.hasReceiverOwnership())
        assertFalse(
            coordinator.publishSignal(generation, publication) {
                error("quarantined publication must not run")
            },
        )
        var successorRegistered = false
        assertThrows(IllegalStateException::class.java) {
            coordinator.start(
                createCandidate = { Any() },
                register = {
                    successorRegistered = true
                },
                unregister = {},
            ) { _, _ ->
                true
            }
        }
        assertFalse(successorRegistered)

        publication.close()
        runBlocking {
            failure.drain.await()
        }
        val retryStop = coordinator.stop {}
        runBlocking {
            retryStop.drain.await()
        }
        assertTrue(coordinator.finishStop(retryStop))
        assertEquals(MonitoringLifecycleState.IDLE, coordinator.state())
        assertFalse(coordinator.hasReceiverOwnership())

        val successor = Any()
        start(coordinator, successor)
        assertTrue(coordinator.isActive())
    }

    @Test
    fun `destroy invalidates callbacks and jobs even when receiver release fails`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val receiver = Any()
        val generation = start(coordinator, receiver)
        val job = Job()
        assertTrue(coordinator.registerJob(job, generation))
        val publication =
            requireNotNull(coordinator.acquireSignalPublication(generation))
        val releaseFailure = SecurityException("unregister denied")

        val result = coordinator.destroy {
            throw releaseFailure
        }

        assertSame(releaseFailure, result.releaseError)
        assertEquals(MonitoringLifecycleState.DESTROYED, coordinator.state())
        assertFalse(coordinator.isActive(generation))
        assertTrue(job.isCancelled)
        assertTrue(coordinator.hasReceiverOwnership())
        assertNull(coordinator.acquireSignalPublication(generation))
        assertFalse(
            coordinator.publishSignal(generation, publication) {
                error("destroyed publication must not run")
            },
        )
        assertThrows(IllegalStateException::class.java) {
            coordinator.start(
                createCandidate = { Any() },
                register = {},
                unregister = {},
            ) { _, _ ->
                true
            }
        }

        publication.close()
        runBlocking {
            result.drain.await()
        }
    }

    @Test
    fun `destroy waits for in-flight start then releases its receiver`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        val receiver = Any()
        val registerEntered = CountDownLatch(1)
        val allowRegister = CountDownLatch(1)
        val startFailure = AtomicReference<Throwable?>()
        val destroyFailure = AtomicReference<Throwable?>()
        val destroyFinished = AtomicBoolean(false)
        val destroyStarted = CountDownLatch(1)
        val unregistered = AtomicReference<Any?>()

        val startThread = Thread {
            try {
                coordinator.start(
                    createCandidate = { receiver },
                    register = {
                        registerEntered.countDown()
                        check(allowRegister.await(5, TimeUnit.SECONDS))
                    },
                    unregister = {
                        unregistered.set(it)
                    },
                ) { _, _ ->
                    Unit
                }
            } catch (error: Throwable) {
                startFailure.set(error)
            }
        }
        startThread.start()
        assertTrue(registerEntered.await(5, TimeUnit.SECONDS))

        val destroyThread = Thread {
            try {
                destroyStarted.countDown()
                coordinator.destroy {
                    unregistered.set(it)
                }
                destroyFinished.set(true)
            } catch (error: Throwable) {
                destroyFailure.set(error)
            }
        }
        destroyThread.start()
        assertTrue(destroyStarted.await(5, TimeUnit.SECONDS))
        assertFalse(destroyFinished.get())

        allowRegister.countDown()
        startThread.join(5_000)
        destroyThread.join(5_000)

        assertNull(startFailure.get())
        assertNull(destroyFailure.get())
        assertTrue(destroyFinished.get())
        assertSame(receiver, unregistered.get())
        assertEquals(MonitoringLifecycleState.DESTROYED, coordinator.state())
        assertFalse(coordinator.hasReceiverOwnership())
        assertFalse(coordinator.isActive())
    }

    @Test
    fun `stop acknowledgment drain owns an in-flight broadcast publication`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val generation = start(coordinator, Any())
        val publication =
            requireNotNull(coordinator.acquireSignalPublication(generation))

        val stopTransition = coordinator.stop {}

        assertEquals(MonitoringLifecycleState.DRAINING, coordinator.state())
        assertFalse(stopTransition.drain.publications.single().isCompleted)
        assertFalse(
            coordinator.publishSignal(generation, publication) {
                error("stopped generation must not publish")
            },
        )
        assertThrows(IllegalStateException::class.java) {
            coordinator.start(
                createCandidate = { Any() },
                register = {},
                unregister = {},
            ) { _, _ ->
                true
            }
        }

        publication.close()
        runBlocking {
            stopTransition.drain.await()
        }
        assertTrue(coordinator.finishStop(stopTransition))
        assertEquals(MonitoringLifecycleState.IDLE, coordinator.state())
    }

    @Test
    fun `old stop completion cannot finish a successor drain`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        start(coordinator, Any())
        val oldStop = coordinator.stop {}
        val duplicateOldStop = coordinator.stop {}

        assertTrue(coordinator.finishStop(oldStop))
        start(coordinator, Any())
        val successorStop = coordinator.stop {}

        assertFalse(coordinator.finishStop(duplicateOldStop))
        assertEquals(MonitoringLifecycleState.DRAINING, coordinator.state())
        assertTrue(coordinator.finishStop(successorStop))
        assertEquals(MonitoringLifecycleState.IDLE, coordinator.state())
    }

    @Test
    fun `listener release closes admission drains old work and rejects concurrent add`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val generation = start(coordinator, Any())
        val oldPublication =
            requireNotNull(coordinator.acquireSignalPublication(generation))
        val releaseCalls = AtomicInteger()

        val release = coordinator.beginSignalListenerRelease {
            releaseCalls.incrementAndGet()
        }

        assertTrue(coordinator.hasPendingListenerRelease())
        assertFalse(release.drain.publications.single().isCompleted)
        assertThrows(IllegalStateException::class.java) {
            coordinator.addSignalListener {}
        }
        assertFalse(
            coordinator.publishSignal(generation, oldPublication) {
                error("old listener generation must not publish")
            },
        )

        oldPublication.close()
        runBlocking {
            release.drain.await()
        }
        assertTrue(coordinator.finishSignalListenerRelease(release))
        coordinator.addSignalListener {}
        val currentPublication =
            coordinator.acquireSignalPublication(generation)

        assertEquals(1, releaseCalls.get())
        assertFalse(coordinator.hasPendingListenerRelease())
        assertNotNull(currentPublication)
        currentPublication?.close()
    }

    @Test
    fun `listener release linearizes after an admitted notification`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val generation = start(coordinator, Any())
        val publication =
            requireNotNull(coordinator.acquireSignalPublication(generation))
        val notificationEntered = CountDownLatch(1)
        val allowNotificationToFinish = CountDownLatch(1)
        val releaseStarted = CountDownLatch(1)
        val releaseFinished = AtomicBoolean(false)
        val order = Collections.synchronizedList(mutableListOf<String>())

        val notificationThread = Thread {
            publication.use {
                assertTrue(
                    coordinator.publishSignal(generation, publication) {
                        notificationEntered.countDown()
                        check(
                            allowNotificationToFinish.await(
                                5,
                                TimeUnit.SECONDS,
                            ),
                        )
                        order.add("notification")
                    },
                )
            }
        }
        notificationThread.start()
        assertTrue(notificationEntered.await(5, TimeUnit.SECONDS))

        val releaseThread = Thread {
            releaseStarted.countDown()
            val release = coordinator.beginSignalListenerRelease {
                order.add("release")
            }
            runBlocking {
                release.drain.await()
            }
            assertTrue(coordinator.finishSignalListenerRelease(release))
            releaseFinished.set(true)
        }
        releaseThread.start()
        assertTrue(releaseStarted.await(5, TimeUnit.SECONDS))
        assertFalse(releaseFinished.get())

        allowNotificationToFinish.countDown()
        notificationThread.join(5_000)
        releaseThread.join(5_000)

        assertTrue(releaseFinished.get())
        assertEquals(listOf("notification", "release"), order)
    }

    @Test
    fun `partially failed listener release blocks add until retry confirms cleanup`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val releaseFailure = IllegalStateException("bridge release failed")

        val failure = assertThrows(SignalListenerReleaseException::class.java) {
            coordinator.beginSignalListenerRelease {
                throw releaseFailure
            }
        }

        assertSame(releaseFailure, failure.cause)
        assertTrue(coordinator.hasPendingListenerRelease())
        assertThrows(IllegalStateException::class.java) {
            coordinator.addSignalListener {}
        }

        val retry = coordinator.beginSignalListenerRelease {}
        runBlocking {
            retry.drain.await()
        }
        assertTrue(coordinator.finishSignalListenerRelease(retry))
        coordinator.addSignalListener {}
        assertFalse(coordinator.hasPendingListenerRelease())
    }

    @Test
    fun `renderer reset prevents an old release completion from clearing its successor`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val oldRelease = coordinator.beginSignalListenerRelease {}

        coordinator.resetSignalListeners {}
        coordinator.addSignalListener {}
        val successorRelease = coordinator.beginSignalListenerRelease {}

        assertFalse(coordinator.finishSignalListenerRelease(oldRelease))
        assertTrue(coordinator.hasPendingListenerRelease())
        assertThrows(IllegalStateException::class.java) {
            coordinator.addSignalListener {}
        }
        assertTrue(coordinator.finishSignalListenerRelease(successorRelease))
        assertFalse(coordinator.hasPendingListenerRelease())
    }

    @Test
    fun `failed renderer reset invalidates old completion but keeps cleanup retryable`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val release = coordinator.beginSignalListenerRelease {}
        val resetFailure = IllegalStateException("bridge reset failed")

        val failure = assertThrows(IllegalStateException::class.java) {
            coordinator.resetSignalListeners {
                throw resetFailure
            }
        }

        assertSame(resetFailure, failure)
        assertFalse(coordinator.finishSignalListenerRelease(release))
        assertTrue(coordinator.hasPendingListenerRelease())
        assertThrows(IllegalStateException::class.java) {
            coordinator.addSignalListener {}
        }

        val retry = coordinator.beginSignalListenerRelease {}
        assertTrue(coordinator.finishSignalListenerRelease(retry))
        assertFalse(coordinator.hasPendingListenerRelease())
        coordinator.addSignalListener {}
    }

    @Test
    fun `successful start rollback drains before a successor can start`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        coordinator.addSignalListener {}
        val receiver = Any()
        val startupFailure = IllegalStateException("start response failed")
        lateinit var publication: SignalPublicationLease

        val failure = assertThrows(MonitoringStartException::class.java) {
            coordinator.start(
                createCandidate = { receiver },
                register = {},
                unregister = {},
            ) { generation, _ ->
                publication =
                    requireNotNull(
                        coordinator.acquireSignalPublication(generation),
                    )
                throw startupFailure
            }
        }

        assertSame(startupFailure, failure.cause)
        assertEquals(MonitoringLifecycleState.DRAINING, coordinator.state())
        assertFalse(coordinator.hasReceiverOwnership())
        assertThrows(IllegalStateException::class.java) {
            coordinator.start(
                createCandidate = { Any() },
                register = {},
                unregister = {},
            ) { _, _ ->
                true
            }
        }

        publication.close()
        runBlocking {
            failure.drain.await()
        }
        val stopTransition = requireNotNull(failure.stopTransition)
        assertTrue(coordinator.finishStop(stopTransition))

        assertEquals(MonitoringLifecycleState.IDLE, coordinator.state())
        start(coordinator, Any())
        assertTrue(coordinator.isActive())
    }

    @Test
    fun `ambiguous registration and failed rollback retain receiver ownership`() {
        val coordinator = MonitoringLifecycleCoordinator<Any>()
        val receiver = Any()
        val registrationFailure =
            SecurityException("registration failed after native crossing")
        val rollbackFailure = SecurityException("rollback unregister denied")

        val failure = assertThrows(MonitoringStartException::class.java) {
            coordinator.start(
                createCandidate = { receiver },
                register = {
                    throw registrationFailure
                },
                unregister = {
                    throw rollbackFailure
                },
            ) { _, _ ->
                true
            }
        }

        assertSame(registrationFailure, failure.cause)
        assertSame(rollbackFailure, registrationFailure.suppressed.single())
        assertEquals(
            MonitoringLifecycleState.TEARDOWN_PENDING,
            coordinator.state(),
        )
        assertTrue(coordinator.hasReceiverOwnership())
        assertThrows(IllegalStateException::class.java) {
            coordinator.start(
                createCandidate = { Any() },
                register = {},
                unregister = {},
            ) { _, _ ->
                true
            }
        }

        val stopTransition = coordinator.stop {}
        runBlocking {
            stopTransition.drain.await()
        }
        assertTrue(coordinator.finishStop(stopTransition))
        assertFalse(coordinator.hasReceiverOwnership())
        assertEquals(MonitoringLifecycleState.IDLE, coordinator.state())
    }

    private fun start(
        coordinator: MonitoringLifecycleCoordinator<Any>,
        receiver: Any,
    ): Long {
        var generation = -1L
        coordinator.start(
            createCandidate = { receiver },
            register = {},
            unregister = {},
        ) { current, newlyAcquired ->
            assertTrue(newlyAcquired)
            generation = current
        }
        return generation
    }
}
