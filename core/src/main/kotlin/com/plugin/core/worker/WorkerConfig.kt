package com.plugin.core.worker

import com.plugin.core.config.properties.WorkerProperties
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * Wires shared worker infra (heartbeat + liveness indicator). Gated by `worker.enabled=true`
 * so the api app boots cleanly without a worker config block.
 */
@Configuration
@ConditionalOnProperty(prefix = "worker", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(WorkerProperties::class)
class WorkerConfig {

    @Bean
    fun workerHeartbeat(): WorkerHeartbeat = WorkerHeartbeat()

    @Bean("workerHeartbeat")
    fun workerHeartbeatHealthIndicator(
        heartbeat: WorkerHeartbeat,
        props: WorkerProperties,
    ): WorkerHeartbeatHealthIndicator = WorkerHeartbeatHealthIndicator(heartbeat, props)
}
