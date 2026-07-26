/**
 * Retains Capacitor listener calls until both the plugin event registry and
 * the bridge's keep-alive callback table have released them.
 */
package ai.eliza.plugins.mobilesignals

internal class NativeListenerCallRegistry<Call> {
    private val lock = Any()
    private val calls = linkedMapOf<String, Call>()

    fun track(callbackId: String, call: Call) {
        synchronized(lock) {
            calls[callbackId] = call
        }
    }

    fun forget(callbackId: String) {
        synchronized(lock) {
            calls.remove(callbackId)
        }
    }

    fun releaseAll(release: (Call) -> Unit) {
        synchronized(lock) {
            for ((callbackId, call) in calls.toList()) {
                release(call)
                calls.remove(callbackId)
            }
        }
    }

    fun isEmpty(): Boolean = synchronized(lock) {
        calls.isEmpty()
    }

    fun snapshot(): List<Call> = synchronized(lock) {
        calls.values.toList()
    }

    fun takeAll(): List<Call> = synchronized(lock) {
        val retained = calls.values.toList()
        calls.clear()
        retained
    }

    fun discardAll() {
        synchronized(lock) {
            calls.clear()
        }
    }
}
