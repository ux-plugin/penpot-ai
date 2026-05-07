package com.plugin.core.ingest

import java.time.Instant

/**
 * Schema for entries on the `ingest.raw` stream. Producers (ingest API) publish these;
 * consumers (sanitizer worker) read them. Keep the field set narrow + stable —
 * downstream stages depend on this contract.
 *
 * Two event types share the stream:
 * - [Type.CHUNK]: one per accepted chunk, carries S3 key + size
 * - [Type.CLOSE_HINT]: one per explicit client close, no chunk fields
 */
data class IngestEvent(
    val type: Type,
    val orgId: String,
    val sessionId: String,
    val chunkSeq: Long? = null,
    val s3Key: String? = null,
    val sizeBytes: Long? = null,
    val receivedAt: Instant = Instant.now(),
) {
    enum class Type { CHUNK, CLOSE_HINT }

    fun toRedisFields(): Map<String, String> = buildMap {
        put("type", type.name)
        put("orgId", orgId)
        put("sessionId", sessionId)
        chunkSeq?.let { put("chunkSeq", it.toString()) }
        s3Key?.let { put("s3Key", it) }
        sizeBytes?.let { put("sizeBytes", it.toString()) }
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
                receivedAt = Instant.ofEpochMilli(fields.getValue("receivedAt").toLong()),
            )
        }
    }
}
