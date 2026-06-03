package com.plugin.core.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * Bound only when `objectstore.endpoint` is set; ObjectStoreConfig gates bean creation
 * on the same key so worker apps without object-store config boot cleanly. Fields are
 * nullable so that scan-based registration never fails on missing config.
 */
@ConfigurationProperties(prefix = "objectstore")
data class ObjectStoreProperties(
    val endpoint: String? = null,
    val accessKey: String? = null,
    val secretKey: String? = null,
    val bucket: String? = null,
    val region: String = "us-east-1",
    val pathStyle: Boolean = true,
    val createBucketOnStartup: Boolean = false,
) {
    fun requireBucket(): String = requireNotNull(bucket) { "objectstore.bucket must be set" }
    fun requireEndpoint(): String = requireNotNull(endpoint) { "objectstore.endpoint must be set" }
    fun requireAccessKey(): String = requireNotNull(accessKey) { "objectstore.access-key must be set" }
    fun requireSecretKey(): String = requireNotNull(secretKey) { "objectstore.secret-key must be set" }
}
