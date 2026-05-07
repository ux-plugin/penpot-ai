package com.plugin.core.storage

import org.reactivestreams.Publisher
import java.nio.ByteBuffer
import java.time.Duration

/**
 * Vendor-neutral object storage abstraction. Backed by S3 protocol so
 * MinIO/AWS S3/GCS-S3-gateway are interchangeable. All paths are bucket-relative keys.
 */
interface ObjectStore {

    suspend fun put(key: String, body: Publisher<ByteBuffer>, contentLength: Long, contentType: String? = null): PutResult

    suspend fun get(key: String): GetResult?

    suspend fun head(key: String): ObjectMetadata?

    suspend fun delete(key: String)

    /**
     * Server-side copy (no download/upload). Used by the sanitizer when relocating
     * a session's chunks from `raw/` to `quarantine/`.
     */
    suspend fun copy(sourceKey: String, destKey: String)

    suspend fun presignGet(key: String, ttl: Duration): String

    data class PutResult(val key: String, val etag: String?)

    data class GetResult(val metadata: ObjectMetadata, val body: Publisher<ByteBuffer>)

    data class ObjectMetadata(
        val key: String,
        val size: Long,
        val etag: String?,
        val contentType: String?,
    )
}
