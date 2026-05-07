package com.plugin.sanitizer.testsupport

import com.plugin.core.config.properties.ObjectStoreProperties
import com.plugin.core.storage.S3ObjectStore
import com.plugin.core.testfixtures.IngestPipelineContainers
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3AsyncClient
import software.amazon.awssdk.services.s3.S3Configuration
import software.amazon.awssdk.services.s3.model.CreateBucketRequest
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.zip.GZIPOutputStream

/**
 * Sanitizer-side mirror of api/test's IngestTestInfra. Builds an [S3ObjectStore] +
 * Redis template against the shared containers, and provides rrweb-shaped fixtures
 * for the lifecycle / classifier / consumer ITs.
 */
object SanitizerTestInfra {

    fun objectStoreProperties(bucket: String = "sanitizer-test"): ObjectStoreProperties = ObjectStoreProperties(
        endpoint = IngestPipelineContainers.minioEndpoint(),
        accessKey = "minioadmin",
        secretKey = "minioadmin",
        bucket = bucket,
        region = "us-east-1",
        pathStyle = true,
    )

    fun buildObjectStore(bucket: String = "sanitizer-test"): S3ObjectStore {
        val props = objectStoreProperties(bucket)
        val s3 = s3Client(props)
        val presigner = s3Presigner(props)
        ensureBucket(s3, bucket)
        return S3ObjectStore(s3, presigner, props)
    }

    fun s3Client(props: ObjectStoreProperties): S3AsyncClient = S3AsyncClient.builder()
        .endpointOverride(URI.create(props.requireEndpoint()))
        .region(Region.of(props.region))
        .credentialsProvider(
            StaticCredentialsProvider.create(AwsBasicCredentials.create(props.requireAccessKey(), props.requireSecretKey())),
        )
        .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(props.pathStyle).build())
        .build()

    fun s3Presigner(props: ObjectStoreProperties): S3Presigner = S3Presigner.builder()
        .endpointOverride(URI.create(props.requireEndpoint()))
        .region(Region.of(props.region))
        .credentialsProvider(
            StaticCredentialsProvider.create(AwsBasicCredentials.create(props.requireAccessKey(), props.requireSecretKey())),
        )
        .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(props.pathStyle).build())
        .build()

    fun buildRedisTemplate(): ReactiveStringRedisTemplate {
        val cfg = RedisStandaloneConfiguration(IngestPipelineContainers.redisHost(), IngestPipelineContainers.redisPort())
        val factory = LettuceConnectionFactory(cfg).also { it.afterPropertiesSet() }
        return ReactiveStringRedisTemplate(factory)
    }

    /**
     * Builds a gzipped ndjson chunk containing the supplied rrweb-shaped events.
     * Each event becomes one ndjson line.
     */
    fun gzippedChunk(events: List<String>): ByteArray {
        val ndjson = events.joinToString(separator = "\n", postfix = "\n")
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(ndjson.toByteArray(Charsets.UTF_8)) }
        return out.toByteArray()
    }

    /** First chunk: includes a Meta event (type=4) followed by a FullSnapshot (type=2). */
    fun firstChunkWithFullSnapshot(): ByteArray = gzippedChunk(
        listOf(
            """{"type":4,"data":{"href":"http://example.test"},"timestamp":1700000000000}""",
            """{"type":2,"data":{"node":{"id":1}},"timestamp":1700000000010}""",
        ),
    )

    /** First chunk: only IncrementalSnapshots (type=3). No FullSnapshot → quarantine. */
    fun firstChunkWithoutFullSnapshot(): ByteArray = gzippedChunk(
        listOf(
            """{"type":3,"data":{},"timestamp":1700000000010}""",
            """{"type":3,"data":{},"timestamp":1700000000020}""",
        ),
    )

    fun followupChunk(): ByteArray = gzippedChunk(
        listOf("""{"type":3,"data":{},"timestamp":1700000000100}"""),
    )

    fun rawKey(orgId: String, sessionId: String, seq: Long): String =
        "raw/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

    fun quarantineKey(orgId: String, sessionId: String, seq: Long): String =
        "quarantine/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

    private fun ensureBucket(s3: S3AsyncClient, bucket: String) {
        try {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()).get()
        } catch (e: Exception) {
            val cause = e.cause ?: e
            val name = cause.javaClass.simpleName
            if (!name.contains("BucketAlreadyOwned") && !name.contains("BucketAlreadyExists")) throw e
        }
    }
}
