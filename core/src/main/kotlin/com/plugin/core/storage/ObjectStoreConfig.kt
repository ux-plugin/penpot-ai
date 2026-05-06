package com.plugin.core.storage

import com.plugin.core.config.properties.ObjectStoreProperties
import com.plugin.core.util.logger
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.event.EventListener
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3AsyncClient
import software.amazon.awssdk.services.s3.S3Configuration
import software.amazon.awssdk.services.s3.model.BucketAlreadyOwnedByYouException
import software.amazon.awssdk.services.s3.model.CreateBucketRequest
import software.amazon.awssdk.services.s3.model.HeadBucketRequest
import software.amazon.awssdk.services.s3.model.NoSuchBucketException
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import java.net.URI

@Configuration
@ConditionalOnProperty(prefix = "objectstore", name = ["endpoint"])
@EnableConfigurationProperties(ObjectStoreProperties::class)
class ObjectStoreConfig {

    @Bean(destroyMethod = "close")
    fun s3AsyncClient(props: ObjectStoreProperties): S3AsyncClient = S3AsyncClient.builder()
        .endpointOverride(URI.create(props.requireEndpoint()))
        .region(Region.of(props.region))
        .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(props.requireAccessKey(), props.requireSecretKey())))
        .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(props.pathStyle).build())
        .build()

    @Bean(destroyMethod = "close")
    fun s3Presigner(props: ObjectStoreProperties): S3Presigner = S3Presigner.builder()
        .endpointOverride(URI.create(props.requireEndpoint()))
        .region(Region.of(props.region))
        .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(props.requireAccessKey(), props.requireSecretKey())))
        .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(props.pathStyle).build())
        .build()

    @Bean
    fun objectStore(s3: S3AsyncClient, presigner: S3Presigner, props: ObjectStoreProperties): ObjectStore =
        S3ObjectStore(s3, presigner, props)

    @Bean
    fun objectStoreBucketBootstrap(s3: S3AsyncClient, props: ObjectStoreProperties): BucketBootstrap =
        BucketBootstrap(s3, props)

    class BucketBootstrap(
        private val s3: S3AsyncClient,
        private val props: ObjectStoreProperties,
    ) {
        private val log = logger()

        @EventListener(ApplicationReadyEvent::class)
        fun ensureBucket() {
            if (!props.createBucketOnStartup) return
            val bucket = props.requireBucket()
            val head = HeadBucketRequest.builder().bucket(bucket).build()
            try {
                s3.headBucket(head).get()
                log.info("Object store bucket '{}' present", bucket)
            } catch (e: Exception) {
                val cause = e.cause ?: e
                if (cause is NoSuchBucketException || cause.message?.contains("404") == true) {
                    log.info("Object store bucket '{}' missing, creating", bucket)
                    try {
                        s3.createBucket(CreateBucketRequest.builder().bucket(bucket).build()).get()
                    } catch (_: BucketAlreadyOwnedByYouException) {
                    }
                } else {
                    log.warn("Object store bucket head failed: {}", cause.message)
                }
            }
        }
    }
}
