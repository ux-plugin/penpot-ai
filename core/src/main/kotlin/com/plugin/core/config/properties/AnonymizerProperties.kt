package com.plugin.core.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Anonymizer worker tunables. Bound only when `anonymizer.enabled=true` so that other
 * worker apps (sanitizer, processor, ingest API) can boot without supplying these
 * values. The rule patterns drive the [com.plugin.anonymizer.rules.RrwebTransformer]
 * pure transform — adding/removing entries is a config-only change.
 */
@ConfigurationProperties(prefix = "anonymizer")
data class AnonymizerProperties(
    val enabled: Boolean = false,
    val inputStream: String = "ingest.sanitized",
    val anonStream: String = "ingest.anon",
    val rawProcessedStream: String = "ingest.raw.processed",
    /** Optional bucket-level prefix; mirrors `ingest.s3-key-prefix`. */
    val s3KeyPrefix: String = "",
    val rules: RulesProperties = RulesProperties(),
) {
    data class RulesProperties(
        /** Drop rrweb `IncrementalSource.Input` events outright (textData scrub). */
        val dropInputEvents: Boolean = true,
        /** Strip query strings from Meta `href` and navigation events. */
        val stripUrlQueryStrings: Boolean = true,
        /**
         * Substring/regex patterns scrubbed from any text content (textData on text
         * nodes, attribute values, console payloads). Replacement is a fixed token so
         * the resulting line is still valid JSON.
         */
        val textPatterns: List<TextPattern> = defaultPatterns(),
    ) {
        companion object {
            fun defaultPatterns(): List<TextPattern> = listOf(
                TextPattern("email", "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "[EMAIL]"),
                // Credit-card before phone — both can match long digit runs, but CC is the
                // higher-severity scrub. Order is significant.
                TextPattern("credit-card", "(?<![0-9])(?:\\d[ -]?){13,19}(?![0-9])", "[CARD]"),
                TextPattern("phone", "(?<![0-9])(\\+?\\d[\\d\\s().-]{7,12}\\d)(?![0-9])", "[PHONE]"),
            )
        }
    }

    data class TextPattern(
        val name: String,
        val pattern: String,
        val replacement: String,
    )
}
