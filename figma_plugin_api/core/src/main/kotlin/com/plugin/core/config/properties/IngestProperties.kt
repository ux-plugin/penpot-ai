package com.plugin.core.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Ingest pipeline tunables. Bound only when `ingest.enabled=true`; gated alongside
 * the controller + service beans so worker apps without ingest config boot cleanly.
 *
 * Stream-transport fields removed in the Kafka migration — the pipeline binding is
 * now declared in `spring.cloud.stream.bindings.*` in application.yaml. The
 * properties here only cover the HTTP-side concerns (size cap, S3 key prefix).
 */
@ConfigurationProperties(prefix = "ingest")
data class IngestProperties(
    val enabled: Boolean = false,
    val maxChunkSizeBytes: Long = 5L * 1024 * 1024,
    val s3KeyPrefix: String = "",
)
