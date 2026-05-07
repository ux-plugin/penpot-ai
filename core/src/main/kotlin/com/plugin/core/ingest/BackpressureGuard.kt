package com.plugin.core.ingest

import com.plugin.core.config.properties.IngestProperties
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import java.util.concurrent.atomic.AtomicReference

/**
 * Cheap fail-fast: checks the configured stream's depth before accepting more chunks.
 *
 * `XLEN` on a hot stream is O(1) but we still cache the result so a burst of inbound
 * requests doesn't fan out to N concurrent XLENs. Cache TTL is short (1s default) so
 * once the threshold clears, new requests start succeeding within ~1s.
 */
class BackpressureGuard(
    private val redis: ReactiveStringRedisTemplate,
    private val props: IngestProperties,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val cached = AtomicReference<CachedLength?>(null)

    /**
     * @throws IngestBackpressureException if the stream depth exceeds [IngestProperties.StreamProperties.maxPending].
     */
    suspend fun assertCapacity() {
        val length = currentLength()
        if (length > props.stream.maxPending) {
            throw IngestBackpressureException(length, props.stream.maxPending, props.stream.backpressureRetryAfterSec)
        }
    }

    suspend fun currentLength(): Long {
        val now = clock()
        val snapshot = cached.get()
        if (snapshot != null && (now - snapshot.fetchedAt) < props.stream.backpressureCacheTtlMs) {
            return snapshot.length
        }
        val length = redis.opsForStream<String, String>().size(props.stream.name).awaitFirstOrNull() ?: 0L
        cached.set(CachedLength(length, now))
        return length
    }

    private data class CachedLength(val length: Long, val fetchedAt: Long)
}

class IngestBackpressureException(
    val streamLength: Long,
    val maxPending: Long,
    val retryAfterSec: Int,
) : RuntimeException("Ingest stream backpressure: $streamLength > $maxPending; retry after $retryAfterSec s")
