package com.plugin.core.worker

import com.plugin.core.config.properties.WorkerProperties
import org.springframework.boot.actuate.health.Health
import org.springframework.boot.actuate.health.HealthIndicator

/**
 * Reads [WorkerHeartbeat.lastBeatMs] from the actuator thread (different from the worker
 * thread). If the worker is stuck in an infinite loop, the bean serving `/health/liveness`
 * still answers — but `lastBeatMs` is frozen, so this indicator returns DOWN.
 *
 * Wire into the liveness group via:
 * ```
 * management.endpoint.health.group.liveness.include: workerHeartbeat, livenessState
 * ```
 * so a stale heartbeat trips the k8s liveness probe → pod restart.
 */
class WorkerHeartbeatHealthIndicator(
    private val heartbeat: WorkerHeartbeat,
    private val props: WorkerProperties,
    private val clock: () -> Long = System::currentTimeMillis,
) : HealthIndicator {

    override fun health(): Health {
        val idleMs = clock() - heartbeat.lastBeatMs
        val thresholdMs = props.heartbeat.thresholdSec * 1_000L
        return if (idleMs > thresholdMs) {
            Health.down()
                .withDetail("idleMs", idleMs)
                .withDetail("thresholdMs", thresholdMs)
                .build()
        } else {
            Health.up()
                .withDetail("idleMs", idleMs)
                .build()
        }
    }
}
