/**
 * Owns coroutine jobs for exactly one monitoring generation so stop and job
 * registration form one atomic cancellation boundary.
 */
package ai.eliza.plugins.mobilesignals

import kotlinx.coroutines.Job

internal class MonitoringJobRegistry {
    private val lock = Any()
    private var activeGeneration: Long? = null
    private val jobs = mutableSetOf<Job>()

    fun activate(generation: Long) {
        synchronized(lock) {
            check(jobs.isEmpty()) {
                "Cannot activate a monitoring generation while prior jobs remain"
            }
            activeGeneration = generation
        }
    }

    fun isActive(generation: Long): Boolean = synchronized(lock) {
        activeGeneration == generation
    }

    fun register(job: Job, generation: Long): Boolean = synchronized(lock) {
        if (activeGeneration != generation) {
            false
        } else {
            jobs.add(job)
            true
        }
    }

    fun complete(job: Job) {
        synchronized(lock) {
            jobs.remove(job)
        }
    }

    fun invalidate(): List<Job> = synchronized(lock) {
        activeGeneration = null
        jobs.toList().also { ownedJobs ->
            for (job in ownedJobs) {
                job.cancel()
            }
        }
    }
}
