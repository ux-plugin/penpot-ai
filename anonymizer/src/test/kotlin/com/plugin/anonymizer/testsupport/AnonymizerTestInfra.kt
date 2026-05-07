package com.plugin.anonymizer.testsupport

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
 * Mirror of `SanitizerTestInfra` for anonymizer ITs. Same shared MinIO + Redis
 * containers via [IngestPipelineContainers]; bucket per test class to keep state
 * isolated.
 */
object AnonymizerTestInfra {

    fun objectStoreProperties(bucket: String = "anonymizer-test"): ObjectStoreProperties = ObjectStoreProperties(
        endpoint = IngestPipelineContainers.minioEndpoint(),
        accessKey = "minioadmin",
        secretKey = "minioadmin",
        bucket = bucket,
        region = "us-east-1",
        pathStyle = true,
    )

    fun buildObjectStore(bucket: String = "anonymizer-test"): S3ObjectStore {
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

    private fun s3Presigner(props: ObjectStoreProperties): S3Presigner = S3Presigner.builder()
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

    fun gzippedChunk(events: List<String>): ByteArray {
        val ndjson = events.joinToString(separator = "\n", postfix = "\n")
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(ndjson.toByteArray(Charsets.UTF_8)) }
        return out.toByteArray()
    }

    /** Realistic chunk shape: Meta + FullSnapshot + textnode containing PII. */
    fun chunkWithPii(): ByteArray = gzippedChunk(
        listOf(
            """{"type":4,"data":{"href":"http://example.test/page?utm=foo&u=bar"},"timestamp":1700000000000}""",
            """{"type":2,"data":{"node":{"textContent":"reach me at alice@example.com or 415-555-1234"}},"timestamp":1700000000010}""",
            """{"type":3,"data":{"source":5,"text":"hunter2"},"timestamp":1700000000020}""",
            """{"type":3,"data":{"source":2,"id":42},"timestamp":1700000000030}""",
        ),
    )

    fun rawKey(orgId: String, sessionId: String, seq: Long): String =
        "raw/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

    fun anonKey(orgId: String, sessionId: String, seq: Long): String =
        "anon/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

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
