package com.plugin.core.ingest

import java.time.Instant

/**
 * Schema for entries on the ingest pipeline streams. Producers (ingest API, sanitizer,
 * anonymizer) publish these; consumers read them. Keep the field set narrow + stable —
 * downstream stages depend on this contract.
 *
 * One [IngestEvent] class spans every stream in the pipeline. The [Type] discriminator
 * tells consumers which fields are populated:
 *
 * | Stream | Type | Carries |
 * |---|---|---|
 * | `ingest.raw` (ingest → sanitizer) | [Type.CHUNK] | chunkSeq, s3Key, sizeBytes |
 * | `ingest.raw` (ingest → sanitizer) | [Type.CLOSE_HINT] | nothing extra |
 * | `ingest.sanitized` (sanitizer → anonymizer) | [Type.SESSION_SANITIZED] | chunkCount, firstSeq, lastSeq, classification |
 * | `ingest.quarantine` (sanitizer → ops) | [Type.SESSION_QUARANTINED] | classification (gap reason), chunkCount |
 * | `ingest.raw.processed` (anonymizer → sanitizer) | [Type.RAW_PROCESSED] | nothing extra (sessionId is the key) |
 *
 * Adding a new stream? Add a [Type] value and document its field expectations here.
 */
data class IngestEvent(
    val type: Type,
    val orgId: String,
    val sessionId: String,
    val chunkSeq: Long? = null,
    val s3Key: String? = null,
    val sizeBytes: Long? = null,
    val chunkCount: Long? = null,
    val firstSeq: Long? = null,
    val lastSeq: Long? = null,
    val classification: String? = null,
    val receivedAt: Instant = Instant.now(),
) {
    enum class Type {
        /** Ingest published a new chunk to S3. Carries chunkSeq + s3Key + sizeBytes. */
        CHUNK,

        /** Client explicitly closed the session (sendBeacon path). No chunk fields. */
        CLOSE_HINT,

        /** Sanitizer determined a session is contiguous + has a FullSnapshot. */
        SESSION_SANITIZED,

        /** Sanitizer determined a session has gaps or is missing required event types. */
        SESSION_QUARANTINED,

        /** Anonymizer finished writing the anon copy; sanitizer can now evict raw. */
        RAW_PROCESSED,
    }

    fun toRedisFields(): Map<String, String> = buildMap {
        put("type", type.name)
        put("orgId", orgId)
        put("sessionId", sessionId)
        chunkSeq?.let { put("chunkSeq", it.toString()) }
        s3Key?.let { put("s3Key", it) }
        sizeBytes?.let { put("sizeBytes", it.toString()) }
        chunkCount?.let { put("chunkCount", it.toString()) }
        firstSeq?.let { put("firstSeq", it.toString()) }
        lastSeq?.let { put("lastSeq", it.toString()) }
        classification?.let { put("classification", it) }
        put("receivedAt", receivedAt.toEpochMilli().toString())
    }

    companion object {
        fun fromRedisFields(fields: Map<String, String>): IngestEvent {
            val type = Type.valueOf(fields.getValue("type"))
            return IngestEvent(
                type = type,
                orgId = fields.getValue("orgId"),
                sessionId = fields.getValue("sessionId"),
                chunkSeq = fields["chunkSeq"]?.toLong(),
                s3Key = fields["s3Key"],
                sizeBytes = fields["sizeBytes"]?.toLong(),
                chunkCount = fields["chunkCount"]?.toLong(),
                firstSeq = fields["firstSeq"]?.toLong(),
                lastSeq = fields["lastSeq"]?.toLong(),
                classification = fields["classification"],
                receivedAt = Instant.ofEpochMilli(fields.getValue("receivedAt").toLong()),
            )
        }
    }
}
