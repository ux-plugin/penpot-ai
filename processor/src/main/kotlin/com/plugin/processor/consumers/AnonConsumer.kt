package com.plugin.processor.consumers

import com.plugin.core.config.properties.ProcessorProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.util.logger
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.core.worker.stream.MessageOutcome
import com.plugin.core.worker.stream.StreamConsumerSupport
import com.plugin.processor.processing.ChunkProcessor
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
 * Consumes `SESSION_ANONYMIZED` events on `ingest.anon`. Each one drives a single
 * [ChunkProcessor.process] call.
 *
 * The processor stage is the pipeline tail — it does not publish anywhere downstream.
 * Failure modes:
 *  - malformed message / unexpected type → DLQ
 *  - SESSION_ANONYMIZED missing firstSeq/lastSeq → DLQ (we can't process a range we
 *    don't know)
 *  - processor throws → leave in PEL for XAUTOCLAIM retry
 */
@Component
class AnonConsumer(
    private val redis: ReactiveStringRedisTemplate,
    private val connectionFactory: ReactiveRedisConnectionFactory,
    private val workerProps: WorkerProperties,
    private val processorProps: ProcessorProperties,
    private val chunkProcessor: ChunkProcessor,
    private val heartbeat: WorkerHeartbeat,
) {
    private val log = logger()
    private val support = StreamConsumerSupport(redis, connectionFactory, workerProps)
    private val streamName = processorProps.inputStream
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
        log.info("processor: {} consumer started: group={} consumer={}", streamName, groupName, workerProps.stream.consumerName)
    }

    @PreDestroy
    fun stop() {
        subscription?.dispose()
        log.info("processor: {} consumer stopped", streamName)
    }

    private suspend fun handle(record: MapRecord<String, String, String>): MessageOutcome {
        heartbeat.beat()
        val event = try {
            IngestEvent.fromRedisFields(record.value)
        } catch (e: Exception) {
            log.error("{}: malformed message {}, routing to DLQ", streamName, record.id, e)
            return MessageOutcome.DEAD
        }
        if (event.type != IngestEvent.Type.SESSION_ANONYMIZED) {
            log.error("{}: unexpected type {} for {}, routing to DLQ", streamName, event.type, record.id)
            return MessageOutcome.DEAD
        }
        val first = event.firstSeq ?: run {
            log.error("{}: SESSION_ANONYMIZED missing firstSeq for {}, routing to DLQ", streamName, record.id)
            return MessageOutcome.DEAD
        }
        val last = event.lastSeq ?: run {
            log.error("{}: SESSION_ANONYMIZED missing lastSeq for {}, routing to DLQ", streamName, record.id)
            return MessageOutcome.DEAD
        }

        return try {
            chunkProcessor.process(event.orgId, event.sessionId, first, last)
            heartbeat.beat()
            MessageOutcome.ACK
        } catch (e: Exception) {
            log.warn("{}: processor threw for {}, leaving in PEL for retry", streamName, record.id, e)
            MessageOutcome.RETRY
        }
    }
}
