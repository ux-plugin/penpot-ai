package com.plugin.api.config.properties

import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "user")
@Validated
data class UserProperties(@field:NotBlank val companionAppKeyPrefix: String, @field:Min(1) val encryptionKeyTtlS: Long)
