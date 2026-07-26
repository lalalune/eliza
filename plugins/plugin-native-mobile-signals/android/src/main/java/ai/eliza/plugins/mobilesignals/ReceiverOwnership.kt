/**
 * Serializes ownership of an Android broadcast receiver across registration
 * and teardown, including calls whose native postcondition is uncertain.
 */
package ai.eliza.plugins.mobilesignals

internal class ReceiverOwnership<T : Any> {
    private val lock = Any()
    private var owned: T? = null

    fun acquire(candidate: T, register: (T) -> Unit) {
        synchronized(lock) {
            check(owned == null) {
                "Cannot acquire a receiver while prior ownership remains"
            }

            // Record the candidate before crossing into Android. A thrown
            // registration call does not prove that Android retained nothing.
            owned = candidate
            register(candidate)
        }
    }

    fun release(unregister: (T) -> Unit) {
        synchronized(lock) {
            val current = owned ?: return
            unregister(current)
            owned = null
        }
    }

    fun owns(candidate: T): Boolean = synchronized(lock) {
        owned === candidate
    }

    fun hasOwnership(): Boolean = synchronized(lock) {
        owned != null
    }
}
