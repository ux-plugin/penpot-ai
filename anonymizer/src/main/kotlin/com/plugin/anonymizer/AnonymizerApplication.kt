package com.plugin.anonymizer

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.autoconfigure.r2dbc.R2dbcAutoConfiguration
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

/**
 * Anonymizer worker — Kafka Streams topology that consumes
 * [com.plugin.core.pipeline.Topics.CHUNKS_SANITIZED], reads the raw chunk from S3,
 * applies [com.plugin.anonymizer.rules.RrwebTransformer], writes the scrubbed
 * chunk under `anon/<orgId>/<sessionId>/<seq>`, and emits
 * [com.plugin.core.pipeline.AnonymizedRecord] to
 * [com.plugin.core.pipeline.Topics.CHUNKS_ANONYMIZED].
 *
 * R2DBC autoconfig stays excluded — anonymizer doesn't touch Postgres.
 * `RrwebTransformer` is stateless, so v1 doesn't need a cross-chunk state store;
 * stateful per-session PII context is a follow-up (see FOLLOWUP.md).
 */
@SpringBootApplication(
    scanBasePackages = ["com.plugin.core", "com.plugin.anonymizer"],
    exclude = [R2dbcAutoConfiguration::class],
)
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.anonymizer"])
class AnonymizerApplication

fun main(args: Array<String>) {
    runApplication<AnonymizerApplication>(*args)
}
