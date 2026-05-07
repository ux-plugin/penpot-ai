package com.plugin.sanitizer.lifecycle

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.storage.ObjectStore
import com.plugin.core.util.logger
import com.plugin.sanitizer.classify.ChunkClassifier
import com.plugin.sanitizer.classify.Classification
import com.plugin.sanitizer.state.SessionState
import com.plugin.sanitizer.state.SessionStateRepository
import org.springframework.stereotype.Service

/**
 * Orchestrates the close-session decision for the sanitizer:
 *
 *   markClosing → classify → S3 ops → publish → maybe delete state
 *
 * Idempotent at every step:
 * - markClosing returns false on retry → caller no-ops
 * - DROP path is delete-then-cleanup; safe to repeat (delete is no-op on missing key)
 * - QUARANTINE path copies then deletes raw — same key on retry just copies again, idempotent
 * - SANITIZED keeps state alive; eviction triggered later via [handleRawProcessed]
 */
@Service
class SessionLifecycleService(
    private val repository: SessionStateRepository,
    private val classifier: ChunkClassifier,
    private val objectStore: ObjectStore,
    private val sanitizedStreamPublisher: SanitizedStreamPublisher,
    private val quarantineStreamPublisher: QuarantineStreamPublisher,
    private val workerProps: WorkerProperties,
) {
    private val log = logger()

    suspend fun closeSession(sessionId: String) {
        val first = repository.markClosing(sessionId)
        if (!first) {
            log.debug("closeSession: {} already closing, skipping", sessionId)
            return
        }

        val state = repository.getState(sessionId)
        if (state == null) {
            log.warn("closeSession: state vanished for {}, treating as DROP", sessionId)
            return
        }

        val result = classifier.classify(state)
        log.info("closeSession: {} → {} ({})", sessionId, result.classification, result.reason)

        when (result.classification) {
            Classification.DROP -> handleDrop(state)
            Classification.SANITIZED -> handleSanitized(state, result.reason)
            Classification.QUARANTINE -> handleQuarantine(state, result.reason)
        }
    }

    /**
     * Anonymizer signalled it has the anon copy. Sanitizer can now evict the raw
     * keys + clear session state. Idempotent: missing keys are no-ops.
     */
    suspend fun handleRawProcessed(orgId: String, sessionId: String) {
        val state = repository.getState(sessionId)
        if (state == null) {
            log.debug("handleRawProcessed: state already gone for {}, idempotent no-op", sessionId)
            return
        }
        deleteRawKeys(state)
        repository.delete(sessionId)
        log.info("handleRawProcessed: evicted raw/{}/{} ({} chunks)", orgId, sessionId, state.chunkCount)
    }

    private suspend fun handleDrop(state: SessionState) {
        deleteRawKeys(state)
        repository.delete(state.sessionId)
    }

    private suspend fun handleSanitized(state: SessionState, reason: String) {
        sanitizedStreamPublisher.publish(
            IngestEvent(
                type = IngestEvent.Type.SESSION_SANITIZED,
                orgId = state.orgId,
                sessionId = state.sessionId,
                chunkCount = state.chunkCount.toLong(),
                firstSeq = state.firstSeq(),
                lastSeq = state.lastSeq(),
                classification = reason,
            ),
        )
        // State retained — handleRawProcessed will fire after anonymizer ACKs.
    }

    private suspend fun handleQuarantine(state: SessionState, reason: String) {
        for (seq in state.chunkSeqs) {
            val raw = rawKey(state.orgId, state.sessionId, seq)
            val quarantine = quarantineKey(state.orgId, state.sessionId, seq)
            objectStore.copy(raw, quarantine)
            objectStore.delete(raw)
        }
        quarantineStreamPublisher.publish(
            IngestEvent(
                type = IngestEvent.Type.SESSION_QUARANTINED,
                orgId = state.orgId,
                sessionId = state.sessionId,
                chunkCount = state.chunkCount.toLong(),
                firstSeq = state.firstSeq(),
                lastSeq = state.lastSeq(),
                classification = reason,
            ),
        )
        repository.delete(state.sessionId)
    }

    private suspend fun deleteRawKeys(state: SessionState) {
        for (seq in state.chunkSeqs) {
            objectStore.delete(rawKey(state.orgId, state.sessionId, seq))
        }
    }

    private fun rawKey(orgId: String, sessionId: String, seq: Long): String =
        "raw/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

    private fun quarantineKey(orgId: String, sessionId: String, seq: Long): String =
        "quarantine/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"
}

/** Marker types so DI can inject the right publisher per output stream. */
class SanitizedStreamPublisher(delegate: IngestStreamPublisher) : DelegatingPublisher(delegate)

class QuarantineStreamPublisher(delegate: IngestStreamPublisher) : DelegatingPublisher(delegate)

abstract class DelegatingPublisher(private val delegate: IngestStreamPublisher) {
    suspend fun publish(event: IngestEvent) {
        delegate.publish(event)
    }
}
