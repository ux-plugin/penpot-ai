package com.plugin.core.storage

import com.plugin.core.config.properties.ObjectStoreProperties
import kotlinx.coroutines.future.await
import org.reactivestreams.Publisher
import software.amazon.awssdk.core.async.AsyncRequestBody
import software.amazon.awssdk.core.async.AsyncResponseTransformer
import software.amazon.awssdk.services.s3.S3AsyncClient
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import software.amazon.awssdk.services.s3.model.CopyObjectRequest
import software.amazon.awssdk.services.s3.model.PutObjectRequest
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest
import java.nio.ByteBuffer
import java.time.Duration

class S3ObjectStore(
    private val s3: S3AsyncClient,
    private val presigner: S3Presigner,
    private val props: ObjectStoreProperties,
) : ObjectStore {

    override suspend fun put(
        key: String,
        body: Publisher<ByteBuffer>,
        contentLength: Long,
        contentType: String?,
    ): ObjectStore.PutResult {
        val req = PutObjectRequest.builder()
            .bucket(props.requireBucket())
            .key(key)
            .contentLength(contentLength)
            .apply { contentType?.let { contentType(it) } }
            .build()
        val res = s3.putObject(req, AsyncRequestBody.fromPublisher(body)).await()
        return ObjectStore.PutResult(key, res.eTag())
    }

    override suspend fun get(key: String): ObjectStore.GetResult? {
        val req = GetObjectRequest.builder().bucket(props.requireBucket()).key(key).build()
        val transformer = AsyncResponseTransformer.toPublisher<software.amazon.awssdk.services.s3.model.GetObjectResponse>()
        return try {
            val publisher = s3.getObject(req, transformer).await()
            val resp = publisher.response()
            ObjectStore.GetResult(
                metadata = ObjectStore.ObjectMetadata(
                    key = key,
                    size = resp.contentLength() ?: 0L,
                    etag = resp.eTag(),
                    contentType = resp.contentType(),
                ),
                body = publisher,
            )
        } catch (_: NoSuchKeyException) {
            null
        }
    }

    override suspend fun head(key: String): ObjectStore.ObjectMetadata? {
        val req = HeadObjectRequest.builder().bucket(props.requireBucket()).key(key).build()
        return try {
            val resp = s3.headObject(req).await()
            ObjectStore.ObjectMetadata(
                key = key,
                size = resp.contentLength() ?: 0L,
                etag = resp.eTag(),
                contentType = resp.contentType(),
            )
        } catch (_: NoSuchKeyException) {
            null
        }
    }

    override suspend fun delete(key: String) {
        s3.deleteObject(DeleteObjectRequest.builder().bucket(props.requireBucket()).key(key).build()).await()
    }

    override suspend fun copy(sourceKey: String, destKey: String) {
        val req = CopyObjectRequest.builder()
            .sourceBucket(props.requireBucket())
            .sourceKey(sourceKey)
            .destinationBucket(props.requireBucket())
            .destinationKey(destKey)
            .build()
        s3.copyObject(req).await()
    }

    override suspend fun presignGet(key: String, ttl: Duration): String {
        val getReq = GetObjectRequest.builder().bucket(props.requireBucket()).key(key).build()
        val presignReq = GetObjectPresignRequest.builder().signatureDuration(ttl).getObjectRequest(getReq).build()
        return presigner.presignGetObject(presignReq).url().toString()
    }
}
