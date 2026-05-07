package com.plugin.sanitizer.consumers

import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.util.logger
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.sanitizer.lifecycle.SessionLifecycleService
import com.plugin.sanitizer.state.SessionStateRepository
import jakarta.annotation.PreDestroy
import kotlinx.coroutines.runBlocking
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.connection.stream.MapRecord
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.stereotype.Component
import reactor.core.Disposable

/**
 * Consumes events from `ingest.raw`. Two event types are dispatched:
 *
 *  - [IngestEvent.Type.CHUNK]: record the chunk seq + size on the session's state
 *  - [IngestEvent.Type.CLOSE_HINT]: invoke the lifecycle service to close the session
 *
 * Other types (SESSION_SANITIZED, SESSION_QUARANTINED, RAW_PROCESSED) shouldn't appear
 * on `ingest.raw` — if they do, treat as poison and route to DLQ.
 *
 * Transient errors leave the message in PEL; XAUTOCLAIM (T46.10) handles redelivery and
 * the retry-budget cutoff that promotes poison to DLQ.
 */
@Component
class IngestRawConsumer(
    private val redis: ReactiveStringRedisTemplate,
    private val connectionFactory: ReactiveRedisConnectionFactory,
    private val workerProps: WorkerProperties,
    private val repository: SessionStateRepository,
    private val lifecycleService: SessionLifecycleService,
    private val heartbeat: WorkerHeartbeat,
) {
    private val log = logger()
    private val support = StreamConsumerSupport(redis, connectionFactory, workerProps)
    private val streamName = "ingest.raw"

    @Volatile private var subscription: Disposable? = null

    @EventListener(ApplicationReadyEvent::class)
    fun start() {
        runBlocking {
            subscription = support.subscribe(
                streamName = streamName,
                groupName = workerProps.stream.consumerGroup,
                consumerName = workerProps.stream.consumerName,
                handler = ::handle,
            )
        }
        log.info("ingest.raw consumer started: group={} consumer={}", workerProps.stream.consumerGroup, workerProps.stream.consumerName)
    }

    @PreDestroy
    fun stop() {
        subscription?.dispose()
        log.info("ingest.raw consumer stopped")
    }

    private suspend fun handle(record: MapRecord<String, String, String>): MessageOutcome {
        heartbeat.beat()
        val event = try {
            IngestEvent.fromRedisFields(record.value)
        } catch (e: Exception) {
            log.error("ingest.raw: malformed message {}, routing to DLQ", record.id, e)
            return MessageOutcome.DEAD
        }

        return try {
            when (event.type) {
                IngestEvent.Type.CHUNK -> {
                    val seq = event.chunkSeq ?: run {
                        log.error("ingest.raw: CHUNK missing chunkSeq, routing to DLQ: {}", event)
                        return MessageOutcome.DEAD
                    }
                    repository.recordChunk(event.orgId, event.sessionId, seq, event.sizeBytes ?: 0L)
                    heartbeat.beat()
                    MessageOutcome.ACK
                }
                IngestEvent.Type.CLOSE_HINT -> {
                    lifecycleService.closeSession(event.sessionId)
                    heartbeat.beat()
                    MessageOutcome.ACK
                }
                else -> {
                    log.error("ingest.raw: unexpected type {} for {}, routing to DLQ", event.type, record.id)
                    MessageOutcome.DEAD
                }
            }
        } catch (e: Exception) {
            log.warn("ingest.raw: handler threw for {}, leaving in PEL for retry", record.id, e)
            MessageOutcome.RETRY
        }
    }
}
