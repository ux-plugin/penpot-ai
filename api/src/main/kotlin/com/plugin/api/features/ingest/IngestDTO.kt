package com.plugin.api.features.ingest

data class IngestAcceptResponse(
    val key: String,
    val etag: String?,
    val sizeBytes: Long,
)

data class CloseSessionResponse(val sessionId: String, val accepted: Boolean = true)
