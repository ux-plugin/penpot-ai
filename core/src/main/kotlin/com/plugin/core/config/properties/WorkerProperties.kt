package com.plugin.core.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Common worker tunables shared by every stream-consumer service (sanitizer, anonymizer,
 * processor). Bound only when `worker.enabled=true`; gated alongside the worker beans so
 * the api app boots cleanly without a worker config block.
 */
@ConfigurationProperties(prefix = "worker")
data class WorkerProperties(
    val enabled: Boolean = false,
    val heartbeat: HeartbeatProperties = HeartbeatProperties(),
    val stream: StreamProperties = StreamProperties(),
    val session: SessionProperties = SessionProperties(),
) {
    /**
     * Threshold in seconds. Liveness probe reports DOWN when the worker hasn't called
     * `WorkerHeartbeat.beat()` for longer than [thresholdSec]. Should be ~2x the worker's
     * worst-case poll cycle so legitimate idle gaps + max GC pauses don't false-DOWN.
     */
    data class HeartbeatProperties(val thresholdSec: Long = 60)

    data class StreamProperties(
        val consumerGroup: String = "worker-grp",
        val consumerName: String = "worker-1",
        val pollTimeoutMs: Long = 5_000,
        val batchSize: Int = 10,
        val reclaim: ReclaimProperties = ReclaimProperties(),
        val dlqSuffix: String = ".dlq",
        val maxDeliveryAttempts: Int = 5,
    )

    data class ReclaimProperties(
        val intervalSec: Long = 30,
        val minIdleTimeSec: Long = 300,
        val batchSize: Int = 100,
    )

    data class SessionProperties(
        val idleTimeoutSec: Long = 600,
        val stateTtlSec: Long = 1_200,
        val minChunksToKeep: Int = 3,
    )
}
