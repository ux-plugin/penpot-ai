package com.plugin.api.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "apikey")
data class ApiKeyProperties(
    val prefix: String = "pk_live_",
    val secretLength: Int = 32,
    val redisCachePrefix: String = "apikey:",
    val redisCacheTtlSec: Long = 60,
    val lastUsedDebounceSec: Long = 60,
)
