package com.plugin.processor.processing

import com.plugin.core.util.logger

/**
 * v0 pass-through. Logs the receipt of an anonymized session range and returns. The
 * AI ticket replaces this with a real implementation (read anon chunks, run inference,
 * persist results); the consumer + ACK semantics stay identical.
 */
class NoopChunkProcessor : ChunkProcessor {
    private val log = logger()

    override suspend fun process(orgId: String, sessionId: String, firstSeq: Long, lastSeq: Long) {
        log.info("noop-process: org={} session={} seqs={}..{}", orgId, sessionId, firstSeq, lastSeq)
    }
}
