package com.plugin.core.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Ingest pipeline tunables. Bound only when `ingest.enabled=true`; gated alongside
 * the controller + service beans so worker apps without ingest config boot cleanly.
 */
@ConfigurationProperties(prefix = "ingest")
data class IngestProperties(
    val enabled: Boolean = false,
    val maxChunkSizeBytes: Long = 5L * 1024 * 1024,
    val s3KeyPrefix: String = "",
    val stream: StreamProperties = StreamProperties(),
) {
    data class StreamProperties(
        val name: String = "ingest.raw",
        val maxPending: Long = 10_000,
        val backpressureRetryAfterSec: Int = 5,
        val backpressureCacheTtlMs: Long = 1_000,
    )
}
