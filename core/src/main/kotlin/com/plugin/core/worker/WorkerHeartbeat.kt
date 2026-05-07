package com.plugin.core.worker

/**
 * Single mutable timestamp updated by the worker thread, read by an external observer
 * (typically [WorkerHeartbeatHealthIndicator] running on the actuator thread pool).
 *
 * `@Volatile` is the contract: writes by the worker thread are visible to the observer
 * without locking. Stuck worker can't write → observer sees stale value → liveness DOWN.
 *
 * Workers should call `beat()`:
 *  - on every successful stream poll cycle (covers legitimate idle gaps),
 *  - after each ACKed message,
 *  - and inside long-running operations via a periodic timer (LLM streaming etc).
 */
class WorkerHeartbeat(private val clock: () -> Long = System::currentTimeMillis) {

    @Volatile var lastBeatMs: Long = clock()
        private set

    fun beat() {
        lastBeatMs = clock()
    }
}
