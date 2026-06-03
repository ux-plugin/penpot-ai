package com.plugin.core.pipeline

/**
 * Canonical Kafka topic names for the ingest pipeline. Centralised so producers
 * (api) and consumers (sanitizer / anonymizer / processor) stay in sync.
 *
 * Partitioning convention: every topic is keyed by `sessionId` so all records for
 * a session land on the same partition → preserved ordering through every stage.
 *
 * Topic creation is automatic on first publish (broker `auto.create.topics.enable`
 * is true on Redpanda dev-mode); production should pre-create with explicit
 * partition counts and retention.
 */
object Topics {
    /** API → sanitizer. One record per uploaded chunk + optional CLOSE_HINT markers. */
    const val CHUNKS_RAW = "chunks.raw"

    /** Sanitizer → anonymizer. One record per chunk after sanitization. */
    const val CHUNKS_SANITIZED = "chunks.sanitized"

    /** Anonymizer → processor. One record per chunk after PII scrubbing. */
    const val CHUNKS_ANONYMIZED = "chunks.anonymized"

    /**
     * Sanitizer → processor. One record per closed session, emitted when the
     * sanitizer's session window closes (inactivity gap expires) or when a
     * CLOSE_HINT marker arrives. Carries the seq range so the processor knows
     * which anonymized chunks form the session.
     */
    const val SESSIONS_CLOSED = "sessions.closed"
}
