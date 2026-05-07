package com.plugin.processor.processing

/**
 * Plug seam for whatever happens to anonymized chunks. v0 is a no-op
 * ([NoopChunkProcessor]); the AI pipeline replaces this without touching the
 * consumer/lifecycle plumbing.
 *
 * Invoked once per session, not per chunk — sanitizer + anonymizer have already
 * grouped chunks into a contiguous range (`firstSeq..lastSeq`).
 *
 * Implementations must be idempotent: the same `(orgId, sessionId, firstSeq, lastSeq)`
 * tuple may be redelivered after a crash and `process` will be called again. ACK
 * happens after `process` returns.
 */
interface ChunkProcessor {
    suspend fun process(orgId: String, sessionId: String, firstSeq: Long, lastSeq: Long)
}
