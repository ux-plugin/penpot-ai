package com.plugin.core.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Processor worker tunables. Bound only when `processor.enabled=true` so other worker
 * apps boot without supplying these values.
 *
 * The [mode] toggle picks the [com.plugin.processor.processing.ChunkProcessor]
 * implementation. `NOOP` is the v0 pass-through; `AI` is reserved for the next ticket
 * that wires the inference pipeline.
 */
@ConfigurationProperties(prefix = "processor")
data class ProcessorProperties(
    val enabled: Boolean = false,
    val inputStream: String = "ingest.anon",
    val mode: Mode = Mode.NOOP,
) {
    enum class Mode { NOOP, AI }
}
