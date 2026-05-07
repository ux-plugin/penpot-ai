package com.plugin.sanitizer.consumers

import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.util.logger
import io.lettuce.core.RedisBusyException
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.data.redis.RedisSystemException
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.connection.stream.Consumer
import org.springframework.data.redis.connection.stream.MapRecord
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.RecordId
import org.springframework.data.redis.connection.stream.StreamOffset
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.data.redis.stream.StreamReceiver
import org.springframework.data.redis.stream.StreamReceiver.StreamReceiverOptions
import reactor.core.Disposable
import reactor.core.publisher.Mono
import java.time.Duration

/**
 * Reactive stream subscription with manual ACK + DLQ semantics. Used by both consumers
 * (raw chunks and raw-processed signals) — they only differ in stream name and message
 * handler.
 */
class StreamConsumerSupport(
    private val redis: ReactiveStringRedisTemplate,
    private val connectionFactory: ReactiveRedisConnectionFactory,
    private val workerProps: WorkerProperties,
) {
    private val log = logger()

    /**
     * Ensures the consumer group exists (idempotent — ignore BUSYGROUP), then subscribes
     * to the stream and dispatches each message to [handler]. The handler decides whether
     * to ACK (success), leave in PEL (transient — retry on next XAUTOCLAIM), or move to
     * the DLQ (permanent / retry-budget exceeded).
     *
     * @return [Disposable] for graceful shutdown.
     */
    suspend fun subscribe(
        streamName: String,
        groupName: String,
        consumerName: String,
        handler: suspend (MapRecord<String, String, String>) -> MessageOutcome,
    ): Disposable {
        ensureGroup(streamName, groupName)

        val options = StreamReceiverOptions.builder()
            .pollTimeout(Duration.ofMillis(workerProps.stream.pollTimeoutMs))
            .build()
        val receiver: StreamReceiver<String, MapRecord<String, String, String>> =
            StreamReceiver.create(connectionFactory, options)

        return receiver.receive(
            Consumer.from(groupName, consumerName),
            StreamOffset.create(streamName, ReadOffset.lastConsumed()),
        ).flatMap { record ->
            Mono.fromCallable { record }
                .flatMap { dispatch(streamName, groupName, it, handler) }
                .onErrorResume { err ->
                    log.error("stream $streamName: dispatch failed unexpectedly for ${record.id}", err)
                    Mono.empty()
                }
        }.subscribe()
    }

    private fun dispatch(
        streamName: String,
        groupName: String,
        record: MapRecord<String, String, String>,
        handler: suspend (MapRecord<String, String, String>) -> MessageOutcome,
    ): Mono<Void> = Mono.defer {
        kotlinx.coroutines.reactor.mono { handler(record) }
            .flatMap { outcome ->
                when (outcome) {
                    MessageOutcome.ACK -> ack(streamName, groupName, record.id).then()
                    MessageOutcome.RETRY -> {
                        // Don't ACK — leave in PEL. XAUTOCLAIM scheduler will redeliver after min-idle-time.
                        log.warn("stream {}: leaving {} in PEL for retry", streamName, record.id)
                        Mono.empty()
                    }
                    MessageOutcome.DEAD -> publishToDlq(streamName, record)
                        .then(ack(streamName, groupName, record.id).then())
                        .doOnSuccess { log.warn("stream {}: routed {} to DLQ", streamName, record.id) }
                }
            }
            .onErrorResume { err ->
                log.error("stream $streamName: handler threw for ${record.id}, retrying via PEL", err)
                Mono.empty()
            }
    }

    private fun ack(streamName: String, groupName: String, id: RecordId): Mono<Long> =
        redis.opsForStream<String, String>().acknowledge(streamName, groupName, id)

    private fun publishToDlq(streamName: String, record: MapRecord<String, String, String>): Mono<RecordId> {
        val dlqStream = streamName + workerProps.stream.dlqSuffix
        val dlqRecord = org.springframework.data.redis.connection.stream.StreamRecords
            .newRecord()
            .ofMap(record.value + mapOf(
                "_originalStream" to streamName,
                "_originalId" to record.id.value,
            ))
            .withStreamKey(dlqStream)
        return redis.opsForStream<String, String>().add(dlqRecord)
    }

    private suspend fun ensureGroup(streamName: String, groupName: String) {
        try {
            redis.opsForStream<String, String>()
                .createGroup(streamName, ReadOffset.from("0"), groupName)
                .awaitFirstOrNull()
        } catch (e: Exception) {
            val cause = e.cause ?: e
            if (cause is RedisBusyException || cause.message?.contains("BUSYGROUP") == true) return
            if (cause is RedisSystemException && cause.message?.contains("BUSYGROUP") == true) return
            // Group create races on app startup — if anyone else created it first, just return.
            if (cause.message?.contains("already exists") == true) return
            throw e
        }
    }
}

enum class MessageOutcome {
    /** Success — XACK and remove from PEL. */
    ACK,

    /** Transient failure — keep in PEL; XAUTOCLAIM will retry after min-idle-time. */
    RETRY,

    /** Permanent failure or retry budget exhausted — XADD to DLQ stream + XACK original. */
    DEAD,
}

