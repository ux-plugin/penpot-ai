package com.plugin.sanitizer.consumers

import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.util.logger
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.sanitizer.lifecycle.SessionLifecycleService
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
 * Consumes [IngestEvent.Type.RAW_PROCESSED] events on the `ingest.raw.processed` stream
 * (published by the anonymizer once it has the anon copy) and triggers raw eviction:
 * delete every `raw/<orgId>/<sessionId>/...` key from S3 and clear session state.
 *
 * Eviction is the privacy-critical step — failure here means raw chunks linger past their
 * intended lifetime. Anything we can't process gets retried via PEL; the 6h S3 lifecycle
 * is the safety net.
 */
@Component
class RawProcessedConsumer(
    private val redis: ReactiveStringRedisTemplate,
    private val connectionFactory: ReactiveRedisConnectionFactory,
    private val workerProps: WorkerProperties,
    private val lifecycleService: SessionLifecycleService,
    private val heartbeat: WorkerHeartbeat,
) {
    private val log = logger()
    private val support = StreamConsumerSupport(redis, connectionFactory, workerProps)
    private val streamName = "ingest.raw.processed"
    private val groupName = "${workerProps.stream.consumerGroup}-evict"

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
        log.info("ingest.raw.processed consumer started: group={}", groupName)
    }

    @PreDestroy
    fun stop() {
        subscription?.dispose()
        log.info("ingest.raw.processed consumer stopped")
    }

    private suspend fun handle(record: MapRecord<String, String, String>): MessageOutcome {
        heartbeat.beat()
        val event = try {
            IngestEvent.fromRedisFields(record.value)
        } catch (e: Exception) {
            log.error("ingest.raw.processed: malformed message {}, routing to DLQ", record.id, e)
            return MessageOutcome.DEAD
        }
        if (event.type != IngestEvent.Type.RAW_PROCESSED) {
            log.error("ingest.raw.processed: unexpected type {} for {}, routing to DLQ", event.type, record.id)
            return MessageOutcome.DEAD
        }

        return try {
            lifecycleService.handleRawProcessed(event.orgId, event.sessionId)
            heartbeat.beat()
            MessageOutcome.ACK
        } catch (e: Exception) {
            log.warn("ingest.raw.processed: handler threw for {}, leaving in PEL for retry", record.id, e)
            MessageOutcome.RETRY
        }
    }
}
