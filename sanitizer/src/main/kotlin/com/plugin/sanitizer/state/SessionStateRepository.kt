package com.plugin.sanitizer.state

import com.plugin.core.config.properties.WorkerProperties
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.data.redis.core.ScanOptions
import org.springframework.stereotype.Repository
import java.time.Duration
import java.time.Instant
import java.util.TreeSet

/**
 * Redis-backed per-session state store. Two keys per session:
 *
 *  - `session:<id>:state`  — hash with `orgId`, `firstSeenAt`, `lastSeenAt`, `totalSizeBytes`, `closing`
 *  - `session:<id>:seqs`   — sorted set of received chunk_seq values (score = seq, member = seq)
 *
 * Both keys share a sliding TTL refreshed by every `recordChunk`. If the worker is offline long
 * enough for the TTL to expire, Redis evicts the keys; reprocessing the stream's PEL after
 * recovery will recreate state cleanly via `recordChunk` (it's an upsert).
 */
@Repository
class SessionStateRepository(
    private val redis: ReactiveStringRedisTemplate,
    private val props: WorkerProperties,
    private val clock: () -> Instant = Instant::now,
) {

    suspend fun recordChunk(orgId: String, sessionId: String, chunkSeq: Long, sizeBytes: Long) {
        val now = clock().toEpochMilli().toString()
        val ttl = Duration.ofSeconds(props.session.stateTtlSec)
        val stateKey = stateKey(sessionId)
        val seqsKey = seqsKey(sessionId)

        val hash = redis.opsForHash<String, String>()
        hash.putAll(stateKey, mapOf(
            "orgId" to orgId,
            "lastSeenAt" to now,
        )).awaitFirstOrNull()
        hash.putIfAbsent(stateKey, "firstSeenAt", now).awaitFirstOrNull()
        hash.increment(stateKey, "totalSizeBytes", sizeBytes).awaitFirstOrNull()
        redis.expire(stateKey, ttl).awaitFirstOrNull()

        redis.opsForZSet().add(seqsKey, chunkSeq.toString(), chunkSeq.toDouble()).awaitFirstOrNull()
        redis.expire(seqsKey, ttl).awaitFirstOrNull()
    }

    suspend fun getState(sessionId: String): SessionState? {
        val hashEntries = redis.opsForHash<String, String>().entries(stateKey(sessionId))
            .collectList().awaitFirstOrNull() ?: return null
        if (hashEntries.isEmpty()) return null
        val hash = hashEntries.associate { it.key to it.value }
        val orgId = hash["orgId"] ?: return null
        val firstSeenAt = hash["firstSeenAt"]?.toLongOrNull()?.let(Instant::ofEpochMilli) ?: return null
        val lastSeenAt = hash["lastSeenAt"]?.toLongOrNull()?.let(Instant::ofEpochMilli) ?: return null
        val totalSizeBytes = hash["totalSizeBytes"]?.toLongOrNull() ?: 0L
        val closing = hash["closing"] == "1"

        val seqs = TreeSet<Long>()
        redis.opsForZSet().range(seqsKey(sessionId), org.springframework.data.domain.Range.unbounded())
            .map { it.toLong() }.collectList().awaitFirstOrNull()?.let { seqs.addAll(it) }

        return SessionState(
            sessionId = sessionId,
            orgId = orgId,
            chunkSeqs = seqs,
            totalSizeBytes = totalSizeBytes,
            firstSeenAt = firstSeenAt,
            lastSeenAt = lastSeenAt,
            closing = closing,
        )
    }

    /** @return true if this call set the closing flag, false if already set. */
    suspend fun markClosing(sessionId: String): Boolean =
        redis.opsForHash<String, String>()
            .putIfAbsent(stateKey(sessionId), "closing", "1")
            .awaitFirstOrNull() == true

    suspend fun delete(sessionId: String) {
        redis.delete(stateKey(sessionId), seqsKey(sessionId)).awaitFirstOrNull()
    }

    /**
     * Streams session IDs whose `lastSeenAt` is older than `thresholdSec`. Uses SCAN
     * (non-blocking) over `session:*:state` keys; intended for the idle-scan scheduler.
     */
    fun findIdleSessions(thresholdSec: Long): Flow<String> = flow {
        val cutoff = clock().minusSeconds(thresholdSec)
        val scan = redis.scan(ScanOptions.scanOptions().match("session:*:state").count(100).build())
        val keys = scan.collectList().awaitFirstOrNull().orEmpty()
        for (key in keys) {
            val sessionId = key.removePrefix("session:").removeSuffix(":state")
            val lastSeenStr = redis.opsForHash<String, String>().get(key, "lastSeenAt").awaitFirstOrNull()
            val closing = redis.opsForHash<String, String>().get(key, "closing").awaitFirstOrNull()
            if (closing == "1") continue
            val lastSeen = lastSeenStr?.toLongOrNull()?.let(Instant::ofEpochMilli) ?: continue
            if (lastSeen.isBefore(cutoff)) emit(sessionId)
        }
    }

    private fun stateKey(sessionId: String) = "session:$sessionId:state"
    private fun seqsKey(sessionId: String) = "session:$sessionId:seqs"
}
