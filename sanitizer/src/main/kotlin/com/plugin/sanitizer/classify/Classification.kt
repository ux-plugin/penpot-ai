package com.plugin.sanitizer.classify

/**
 * Outcome of [ChunkClassifier.classify] for a closed session.
 *
 * - [DROP]: session never reached the configured min chunk count; not worth keeping.
 *   Sanitizer deletes raw/, no downstream event.
 * - [SANITIZED]: contiguous chunks 0..N AND first chunk contains an rrweb FullSnapshot
 *   event (type=2). Sanitizer publishes `ingest.sanitized`.
 * - [QUARANTINE]: gaps OR missing FullSnapshot. Sanitizer S3-mvs raw/ keys to quarantine/
 *   and publishes `ingest.quarantine`. Ops can review or auto-delete via lifecycle.
 */
enum class Classification { DROP, SANITIZED, QUARANTINE }

data class ClassificationResult(val classification: Classification, val reason: String)
