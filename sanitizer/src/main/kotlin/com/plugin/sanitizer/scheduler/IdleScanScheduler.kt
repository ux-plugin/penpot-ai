package com.plugin.sanitizer.scheduler

import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.util.logger
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.sanitizer.lifecycle.SessionLifecycleService
import com.plugin.sanitizer.state.SessionStateRepository
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/**
 * Periodic scan for sessions that have been silent past `worker.session.idle-timeout-sec`
 * (default 10 min) and have not yet been closed. Closes each one through
 * [SessionLifecycleService] — same path the explicit CLOSE_HINT takes — so the
 * classification + S3 ops + downstream publish behave identically.
 *
 * Heartbeats during the scan so a long iteration doesn't trip the liveness probe.
 */
@Component
class IdleScanScheduler(
    private val repository: SessionStateRepository,
    private val lifecycleService: SessionLifecycleService,
    private val workerProps: WorkerProperties,
    private val heartbeat: WorkerHeartbeat,
) {
    private val log = logger()

    @Scheduled(fixedDelayString = "\${worker.scheduler.idle-scan-fixed-delay-ms:60000}")
    fun scanIdleSessions() {
        heartbeat.beat()
        runBlocking {
            var processed = 0
            repository.findIdleSessions(workerProps.session.idleTimeoutSec).collect { sessionId ->
                heartbeat.beat()
                try {
                    lifecycleService.closeSession(sessionId)
                    processed++
                } catch (e: Exception) {
                    log.warn("idle-scan: closeSession({}) failed", sessionId, e)
                }
            }
            heartbeat.beat()
            if (processed > 0) log.info("idle-scan: closed {} idle sessions", processed)
        }
    }
}
