package com.plugin.api.features.ingest

import com.plugin.api.security.AuthorizationService
import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.util.logger
import kotlinx.coroutines.reactive.awaitSingle
import org.reactivestreams.Publisher
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.core.io.buffer.DataBuffer
import org.springframework.core.io.buffer.DataBufferUtils
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import java.nio.ByteBuffer

/**
 * Ingest API. All endpoints require an [ApiKeyAuthentication] in the reactive security
 * context — JWT-only callers are rejected with 403 since ingest is SDK-to-server only.
 */
@RestController
@RequestMapping("/ingest")
@ConditionalOnProperty(prefix = "ingest", name = ["enabled"], havingValue = "true")
class IngestionController(
    private val service: IngestionService,
    private val authorizationService: AuthorizationService,
    private val ingestProperties: IngestProperties,
) {
    private val log = logger()

    @PostMapping("/sessions/{sessionId}/chunks/{chunkSeq}")
    suspend fun acceptChunk(
        @PathVariable sessionId: String,
        @PathVariable chunkSeq: Long,
        @RequestHeader(HttpHeaders.CONTENT_LENGTH, required = false) contentLength: Long?,
        @RequestHeader(value = HttpHeaders.CONTENT_TYPE, required = false) contentType: String?,
        @RequestBody body: Flux<DataBuffer>,
        exchange: ServerWebExchange,
    ): ResponseEntity<*> {
        val auth = authorizationService.currentApiKeyAuthentication()
            ?: return unauthorized()

        if (contentLength == null) {
            return ResponseEntity.status(HttpStatus.LENGTH_REQUIRED).body(error("content_length_required"))
        }
        if (contentLength > ingestProperties.maxChunkSizeBytes) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(
                error("chunk_too_large", "max" to ingestProperties.maxChunkSizeBytes, "actual" to contentLength),
            )
        }
        if (contentType != null && !isAcceptedContentType(contentType)) {
            return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(error("unsupported_content_type"))
        }
        if (chunkSeq < 0) {
            return ResponseEntity.badRequest().body(error("chunk_seq_negative"))
        }

        // Bounded by maxChunkSizeBytes (5 MB default), so joining into one buffer is safe.
        // True chunked-PUT streaming can be added later via S3 multipart.
        val joined = DataBufferUtils.join(body).awaitSingle()
        // Copy out before release. `joined.toByteBuffer(dest)` doesn't exist on
        // Spring 6.x DataBuffer — it was a no-op + flip dropped the data.
        val byteBuffer = try {
            val len = joined.readableByteCount()
            val out = ByteBuffer.allocate(len)
            joined.toByteBuffer(0, out, 0, len)
            out.position(0)
            out.limit(len)
            out
        } finally {
            DataBufferUtils.release(joined)
        }

        log.info("ingest: accept-chunk org={} session={} seq={} bytes={}", auth.orgId, sessionId, chunkSeq, contentLength)
        val result = service.acceptChunk(
            orgId = auth.orgId,
            sessionId = sessionId,
            chunkSeq = chunkSeq,
            contentLength = contentLength,
            body = Mono.just(byteBuffer) as Publisher<ByteBuffer>,
            contentType = contentType,
        )
        return ResponseEntity.accepted().body(result)
    }

    @PostMapping("/sessions/{sessionId}/close")
    suspend fun closeSession(@PathVariable sessionId: String): ResponseEntity<*> {
        val auth = authorizationService.currentApiKeyAuthentication() ?: return unauthorized()
        log.info("ingest: close-hint org={} session={}", auth.orgId, sessionId)
        val result = service.acceptCloseHint(orgId = auth.orgId, sessionId = sessionId)
        return ResponseEntity.accepted().body(result)
    }

    private fun unauthorized(): ResponseEntity<Map<String, Any>> =
        ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(error("api_key_required"))

    private fun isAcceptedContentType(contentType: String): Boolean {
        val parsed = runCatching { MediaType.parseMediaType(contentType) }.getOrNull() ?: return false
        return parsed.includes(MediaType.parseMediaType("application/x-ndjson")) ||
            parsed.includes(MediaType.APPLICATION_OCTET_STREAM) ||
            parsed.includes(MediaType.parseMediaType("application/gzip"))
    }

    private fun error(code: String, vararg extras: Pair<String, Any>): Map<String, Any> =
        buildMap {
            put("error", code)
            extras.forEach { (k, v) -> put(k, v) }
        }
}
