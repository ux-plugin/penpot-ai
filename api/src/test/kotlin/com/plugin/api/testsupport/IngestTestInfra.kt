package com.plugin.api.testsupport

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
import java.net.URI

/**
 * Helpers for ingestion ITs: build an [S3ObjectStore] backed by the shared MinIO
 * container, ensure the test bucket exists, and return a reactive Redis template
 * pointed at the shared Redis container.
 */
object IngestTestInfra {

    fun objectStoreProperties(bucket: String = "ingest-test"): ObjectStoreProperties = ObjectStoreProperties(
        endpoint = IngestPipelineContainers.minioEndpoint(),
        accessKey = "minioadmin",
        secretKey = "minioadmin",
        bucket = bucket,
        region = "us-east-1",
        pathStyle = true,
    )

    fun buildObjectStore(bucket: String = "ingest-test"): S3ObjectStore {
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

    private fun ensureBucket(s3: S3AsyncClient, bucket: String) {
        try {
            s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()).get()
        } catch (e: Exception) {
            // Bucket already exists — MinIO returns BucketAlreadyOwnedByYouException; ignore.
            val cause = e.cause ?: e
            val name = cause.javaClass.simpleName
            if (!name.contains("BucketAlreadyOwned") && !name.contains("BucketAlreadyExists")) throw e
        }
    }
}
