package com.plugin.core.ingest

import com.plugin.core.config.properties.IngestProperties
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.data.redis.connection.stream.MapRecord
import org.springframework.data.redis.connection.stream.RecordId
import org.springframework.data.redis.connection.stream.StreamRecords
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

/**
 * Publishes [IngestEvent]s to the configured Redis stream via XADD. Suspend wrapper around
 * the reactive [ReactiveStringRedisTemplate] so callers (controllers, services) stay in the
 * suspend domain.
 *
 * Returns the Redis-assigned [RecordId] (timestamp-seq pair) for trace logging.
 */
class IngestStreamPublisher(
    private val redis: ReactiveStringRedisTemplate,
    private val props: IngestProperties,
) {

    suspend fun publish(event: IngestEvent): RecordId? {
        val record: MapRecord<String, String, String> = StreamRecords.newRecord()
            .ofMap(event.toRedisFields())
            .withStreamKey(props.stream.name)
        return redis.opsForStream<String, String>().add(record).awaitFirstOrNull()
    }
}
