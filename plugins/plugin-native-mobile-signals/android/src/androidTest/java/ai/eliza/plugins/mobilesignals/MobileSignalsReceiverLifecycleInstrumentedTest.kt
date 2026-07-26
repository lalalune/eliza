/**
 * Exercises receiver release against Android's real Context implementation,
 * including the idempotent already-unregistered postcondition.
 */
package ai.eliza.plugins.mobilesignals

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobileSignalsReceiverLifecycleInstrumentedTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun registeredThenAlreadyUnregisteredBothConfirmAbsence() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) = Unit
        }
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_SCREEN_ON))

        unregisterReceiverOrConfirmAbsent {
            context.unregisterReceiver(receiver)
        }
        unregisterReceiverOrConfirmAbsent {
            context.unregisterReceiver(receiver)
        }
    }

    @Test
    fun inFlightReceiverPublicationDrainsBeforeStopCompletion() {
        val coordinator = MonitoringLifecycleCoordinator<BroadcastReceiver>()
        val action = "${context.packageName}.MONITORING_DRAIN_TEST"
        val callbackEntered = CountDownLatch(1)
        val allowCallbackToFinish = CountDownLatch(1)
        val published = AtomicInteger()
        coordinator.addSignalListener {}

        var generation = -1L
        coordinator.start(
            createCandidate = { currentGeneration ->
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        val lease =
                            coordinator.acquireSignalPublication(currentGeneration)
                                ?: return
                        lease.use {
                            callbackEntered.countDown()
                            check(allowCallbackToFinish.await(5, TimeUnit.SECONDS))
                            coordinator.publishSignal(currentGeneration, lease) {
                                published.incrementAndGet()
                            }
                        }
                    }
                }
            },
            register = { receiver ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    context.registerReceiver(
                        receiver,
                        IntentFilter(action),
                        Context.RECEIVER_NOT_EXPORTED,
                    )
                } else {
                    context.registerReceiver(receiver, IntentFilter(action))
                }
            },
            unregister = context::unregisterReceiver,
        ) { currentGeneration, _ ->
            generation = currentGeneration
        }

        context.sendBroadcast(Intent(action).setPackage(context.packageName))
        assertTrue(callbackEntered.await(5, TimeUnit.SECONDS))
        assertTrue(coordinator.isActive(generation))

        val stopTransition = coordinator.stop(context::unregisterReceiver)

        assertEquals(MonitoringLifecycleState.DRAINING, coordinator.state())
        assertFalse(
            stopTransition.drain.publications.single().isCompleted,
        )
        allowCallbackToFinish.countDown()
        runBlocking {
            stopTransition.drain.await()
        }
        assertTrue(coordinator.finishStop(stopTransition))
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()

        assertEquals(0, published.get())
        assertEquals(MonitoringLifecycleState.IDLE, coordinator.state())
    }
}
