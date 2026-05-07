package com.plugin.sanitizer.state

import java.time.Instant

/**
 * In-memory snapshot of a session's accumulated state. Hydrated by [SessionStateRepository]
 * from Redis. Sanitizer's classifier and lifecycle service consume this, then write back via
 * the repository.
 */
data class SessionState(
    val sessionId: String,
    val orgId: String,
    val chunkSeqs: SortedSet<Long>,
    val totalSizeBytes: Long,
    val firstSeenAt: Instant,
    val lastSeenAt: Instant,
    val closing: Boolean,
) {
    val chunkCount: Int get() = chunkSeqs.size

    fun firstSeq(): Long? = chunkSeqs.firstOrNull()
    fun lastSeq(): Long? = chunkSeqs.lastOrNull()

    /** Returns the missing chunk_seq values within `[0, lastSeq]`, or empty if contiguous. */
    fun gaps(): List<Long> {
        val last = lastSeq() ?: return emptyList()
        if (chunkSeqs.size.toLong() == last + 1) return emptyList()
        val received = chunkSeqs
        return (0L..last).filter { it !in received }
    }
}

private typealias SortedSet<T> = java.util.SortedSet<T>
