package com.plugin.anonymizer.rules

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.databind.node.TextNode
import com.plugin.core.util.logger
import org.springframework.stereotype.Component
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/**
 * Pure transform: takes a gzipped NDJSON chunk of rrweb events, returns a gzipped
 * NDJSON chunk with PII scrubbed.
 *
 * Operations (each toggled by [AnonymizerRules]):
 *  - Drop rrweb `IncrementalSnapshot` events whose `data.source == 5` (Input). The
 *    typed input value is the highest-risk field — scrubbing alone is unsafe.
 *  - Strip query strings from Meta (`type=4`) `href`. Query strings are a common
 *    leakage vector for tokens, emails, and session ids.
 *  - Walk every string in every event and apply the configured text patterns
 *    (email, phone, credit-card by default). Object keys are not touched.
 *
 * Idempotent: re-running on already-scrubbed content yields identical output (regex
 * replacement tokens like `[EMAIL]` don't match the original patterns).
 *
 * Stateless — no IO, no Spring boundary. Safe to call from a coroutine context.
 */
@Component
class RrwebTransformer(
    private val rules: AnonymizerRules,
    private val mapper: ObjectMapper = ObjectMapper(),
) {
    private val log = logger()

    /** Gzipped NDJSON in → gzipped NDJSON out. */
    fun transformGzipped(gzipped: ByteArray): ByteArray {
        val ndjson = gunzip(gzipped)
        val transformed = transformNdjson(ndjson)
        return gzip(transformed)
    }

    /** Plain NDJSON in → plain NDJSON out. Exposed for tests + golden fixtures. */
    fun transformNdjson(ndjson: String): String {
        val out = StringBuilder(ndjson.length)
        for (line in ndjson.lineSequence()) {
            if (line.isBlank()) continue
            val transformed = transformLine(line) ?: continue
            out.append(transformed).append('\n')
        }
        return out.toString()
    }

    /** Returns the rewritten line, or null if the event was dropped. */
    private fun transformLine(line: String): String? {
        val node = try {
            mapper.readTree(line)
        } catch (e: Exception) {
            // Malformed entry — pass through verbatim rather than crash the chunk. The
            // sanitizer should have caught syntactic damage upstream; this is a guard.
            log.warn("transform: skipping malformed line ({}): {}", e.message, line.take(80))
            return line
        }
        if (node !is ObjectNode) return line

        val type = node.get("type")?.asInt()
        val source = node.get("data")?.get("source")?.asInt()
        if (rules.dropInputEvents && type == EVENT_TYPE_INCREMENTAL && source == SOURCE_INPUT) {
            return null
        }

        if (rules.stripUrlQueryStrings && type == EVENT_TYPE_META) {
            stripHref(node)
        }

        scrubStrings(node)
        return mapper.writeValueAsString(node)
    }

    private fun stripHref(event: ObjectNode) {
        val data = event.get("data") as? ObjectNode ?: return
        val href = data.get("href")?.asText() ?: return
        val q = href.indexOf('?')
        val f = href.indexOf('#')
        val cut = listOf(q, f).filter { it >= 0 }.minOrNull() ?: return
        data.put("href", href.substring(0, cut))
    }

    /** Recursively rewrite every string leaf via the rules engine. */
    private fun scrubStrings(node: JsonNode) {
        when (node) {
            is ObjectNode -> {
                val keys = node.fieldNames().asSequence().toList()
                for (key in keys) {
                    when (val value = node.get(key)) {
                        is TextNode -> {
                            val original = value.asText()
                            val scrubbed = rules.scrubText(original)
                            if (scrubbed != original) node.put(key, scrubbed)
                        }
                        is ObjectNode, is ArrayNode -> scrubStrings(value)
                        else -> {}
                    }
                }
            }
            is ArrayNode -> {
                for (i in 0 until node.size()) {
                    when (val child = node.get(i)) {
                        is TextNode -> {
                            val original = child.asText()
                            val scrubbed = rules.scrubText(original)
                            if (scrubbed != original) node.set(i, TextNode(scrubbed))
                        }
                        is ObjectNode, is ArrayNode -> scrubStrings(child)
                        else -> {}
                    }
                }
            }
            else -> {}
        }
    }

    private fun gunzip(bytes: ByteArray): String =
        GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader(Charsets.UTF_8).use { it.readText() }

    private fun gzip(text: String): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(text.toByteArray(Charsets.UTF_8)) }
        return out.toByteArray()
    }

    companion object {
        // rrweb event types. See https://github.com/rrweb-io/rrweb/blob/master/packages/types/src/index.ts
        private const val EVENT_TYPE_INCREMENTAL = 3
        private const val EVENT_TYPE_META = 4
        // rrweb IncrementalSource enum value for Input.
        private const val SOURCE_INPUT = 5
    }
}
