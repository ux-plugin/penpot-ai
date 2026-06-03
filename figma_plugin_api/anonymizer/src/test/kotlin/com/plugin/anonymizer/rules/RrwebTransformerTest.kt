package com.plugin.anonymizer.rules

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.core.config.properties.AnonymizerProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Pure-unit coverage of the transformer. No Spring, no containers — this is the
 * critical privacy boundary so we test the raw rule outputs directly.
 */
class RrwebTransformerTest {

    private val mapper = ObjectMapper()
    private val props = AnonymizerProperties(enabled = true)
    private val rules = AnonymizerRules(props)
    private val transformer = RrwebTransformer(rules, mapper)

    @Test
    fun `drops IncrementalSnapshot Input events`() {
        val input = """
            {"type":2,"data":{"node":{"id":1}},"timestamp":1}
            {"type":3,"data":{"source":5,"text":"secret"},"timestamp":2}
            {"type":3,"data":{"source":2,"id":1},"timestamp":3}
        """.trimIndent()

        val out = transformer.transformNdjson(input).trim().lines()

        assertThat(out).hasSize(2)
        assertThat(out.none { it.contains("\"source\":5") }).isTrue()
        assertThat(out.any { it.contains("\"source\":2") }).isTrue()
    }

    @Test
    fun `keeps Input events when rule disabled`() {
        val customProps = AnonymizerProperties(rules = AnonymizerProperties.RulesProperties(dropInputEvents = false))
        val custom = RrwebTransformer(AnonymizerRules(customProps), mapper)
        val input = """{"type":3,"data":{"source":5,"text":"x"},"timestamp":1}"""

        val out = custom.transformNdjson(input).trim()

        assertThat(out).contains("\"source\":5")
    }

    @Test
    fun `strips query string from Meta href`() {
        val input = """{"type":4,"data":{"href":"http://example.com/path?token=abc&u=joe"},"timestamp":1}"""

        val out = transformer.transformNdjson(input).trim()

        assertThat(out).contains("\"href\":\"http://example.com/path\"")
        assertThat(out).doesNotContain("token=abc")
    }

    @Test
    fun `strips fragment from Meta href`() {
        val input = """{"type":4,"data":{"href":"http://example.com/path#section"},"timestamp":1}"""

        val out = transformer.transformNdjson(input).trim()

        assertThat(out).contains("\"href\":\"http://example.com/path\"")
    }

    @Test
    fun `scrubs email`() {
        val input = """{"type":3,"data":{"source":0,"text":"contact me at alice@example.com"},"timestamp":1}"""

        val out = transformer.transformNdjson(input).trim()

        assertThat(out).contains("[EMAIL]")
        assertThat(out).doesNotContain("alice@example.com")
    }

    @Test
    fun `scrubs phone numbers`() {
        val input = """{"type":3,"data":{"source":0,"text":"call +1 415-555-1234 today"},"timestamp":1}"""

        val out = transformer.transformNdjson(input).trim()

        assertThat(out).contains("[PHONE]")
        assertThat(out).doesNotContain("415-555-1234")
    }

    @Test
    fun `scrubs credit card`() {
        val input = """{"type":3,"data":{"source":0,"text":"4111 1111 1111 1111 expires 01-30"},"timestamp":1}"""

        val out = transformer.transformNdjson(input).trim()

        assertThat(out).contains("[CARD]")
        assertThat(out).doesNotContain("4111 1111 1111 1111")
    }

    @Test
    fun `walks nested arrays and objects`() {
        val input = """{"type":2,"data":{"adds":[{"node":{"textContent":"email me at bob@example.com"}}]},"timestamp":1}"""

        val out = transformer.transformNdjson(input).trim()

        assertThat(out).contains("[EMAIL]")
        assertThat(out).doesNotContain("bob@example.com")
    }

    @Test
    fun `is idempotent on already-scrubbed content`() {
        val input = """{"type":3,"data":{"source":0,"text":"contact alice@example.com"},"timestamp":1}"""

        val once = transformer.transformNdjson(input)
        val twice = transformer.transformNdjson(once)

        assertThat(twice).isEqualTo(once)
    }

    @Test
    fun `passes through malformed lines without crashing`() {
        val input = """
            {not valid json
            {"type":3,"data":{"source":2},"timestamp":1}
        """.trimIndent()

        val out = transformer.transformNdjson(input).trim().lines()

        assertThat(out).hasSize(2)
        assertThat(out[0]).isEqualTo("{not valid json")
        assertThat(out[1]).contains("\"source\":2")
    }

    @Test
    fun `skips blank lines`() {
        val input = "\n\n${"""{"type":3,"data":{"source":2},"timestamp":1}"""}\n\n"

        val out = transformer.transformNdjson(input).trim().lines()

        assertThat(out).hasSize(1)
    }

    @Test
    fun `gzipped roundtrip`() {
        val ndjson = """{"type":3,"data":{"source":0,"text":"alice@example.com"},"timestamp":1}"""
        val gz = java.io.ByteArrayOutputStream().also { o ->
            java.util.zip.GZIPOutputStream(o).use { it.write("$ndjson\n".toByteArray()) }
        }.toByteArray()

        val transformed = transformer.transformGzipped(gz)
        val decoded = java.util.zip.GZIPInputStream(java.io.ByteArrayInputStream(transformed))
            .bufferedReader().use { it.readText() }

        assertThat(decoded).contains("[EMAIL]")
        assertThat(decoded).doesNotContain("alice@example.com")
    }
}
