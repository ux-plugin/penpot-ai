package com.plugin.anonymizer.consumers

import com.plugin.anonymizer.lifecycle.SessionAnonymizationService
import com.plugin.core.config.properties.AnonymizerProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.util.logger
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.core.worker.stream.MessageOutcome
import com.plugin.core.worker.stream.StreamConsumerSupport
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
 * Consumes `SESSION_SANITIZED` events on `ingest.sanitized`. For each one, drives the
 * full per-session anonymization pipeline through [SessionAnonymizationService].
 *
 * Anything else on this stream is poison — sanitizer publishes only `SESSION_SANITIZED`
 * here, so other types and malformed messages route to the DLQ.
 */
@Component
class SanitizedConsumer(
    private val redis: ReactiveStringRedisTemplate,
    private val connectionFactory: ReactiveRedisConnectionFactory,
    private val workerProps: WorkerProperties,
    private val anonProps: AnonymizerProperties,
    private val anonymizationService: SessionAnonymizationService,
    private val heartbeat: WorkerHeartbeat,
) {
    private val log = logger()
    private val support = StreamConsumerSupport(redis, connectionFactory, workerProps)
    private val streamName = anonProps.inputStream
    private val groupName = workerProps.stream.consumerGroup

    @Volatile private var subscription: Disposable? = null

    @EventListener(ApplicationReadyEvent::class)
    fun start() {
        runBlocking {
            subscription = support.subscribe(
                streamName = streamName,
                groupName = groupName,
                consumerName = workerProps.stream.consumerName,
                handler = ::handle,
            )
        }
        log.info("anonymizer: {} consumer started: group={} consumer={}", streamName, groupName, workerProps.stream.consumerName)
    }

    @PreDestroy
    fun stop() {
        subscription?.dispose()
        log.info("anonymizer: {} consumer stopped", streamName)
    }

    private suspend fun handle(record: MapRecord<String, String, String>): MessageOutcome {
        heartbeat.beat()
        val event = try {
            IngestEvent.fromRedisFields(record.value)
        } catch (e: Exception) {
            log.error("{}: malformed message {}, routing to DLQ", streamName, record.id, e)
            return MessageOutcome.DEAD
        }
        if (event.type != IngestEvent.Type.SESSION_SANITIZED) {
            log.error("{}: unexpected type {} for {}, routing to DLQ", streamName, event.type, record.id)
            return MessageOutcome.DEAD
        }
        val first = event.firstSeq ?: run {
            log.error("{}: SESSION_SANITIZED missing firstSeq for {}, routing to DLQ", streamName, record.id)
            return MessageOutcome.DEAD
        }
        val last = event.lastSeq ?: run {
            log.error("{}: SESSION_SANITIZED missing lastSeq for {}, routing to DLQ", streamName, record.id)
            return MessageOutcome.DEAD
        }

        return try {
            anonymizationService.anonymize(event.orgId, event.sessionId, first, last)
            heartbeat.beat()
            MessageOutcome.ACK
        } catch (e: Exception) {
            log.warn("{}: handler threw for {}, leaving in PEL for retry", streamName, record.id, e)
            MessageOutcome.RETRY
        }
    }
}
