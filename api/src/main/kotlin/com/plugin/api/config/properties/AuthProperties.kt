package com.plugin.api.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "auth")
@Validated
data class AuthProperties(
    @field:Valid @field:NotNull val figma: FigmaProperties,
    @field:Valid @field:NotNull val github: GitHubProperties,
) {
    data class FigmaProperties(
        @field:NotBlank val clientId: String,
        @field:NotBlank val clientSecret: String,
        @field:NotBlank val authUrl: String,
        @field:NotBlank val tokenUrl: String,
        @field:NotBlank val connectRedirectUri: String,
        @field:Valid @field:NotNull val userId: ResultKeyPrefixProperties,
        @field:Valid @field:NotNull val connect: RedisKeyPrefixProperties,
        @field:Valid @field:NotNull val flow: FlowProperties,
        @field:Valid @field:NotNull val readToken: RedisKeyPrefixProperties,
        @field:Valid @field:NotNull val writeToken: RedisKeyPrefixProperties,
    )

    data class GitHubProperties(
        @field:NotBlank val clientId: String,
        @field:NotBlank val clientSecret: String,
        @field:NotBlank val authUrl: String,
        @field:NotBlank val tokenUrl: String,
        @field:NotBlank val connectRedirectUri: String,
        @field:Valid @field:NotNull val connect: ResultKeyPrefixProperties,
        @field:Valid @field:NotNull val userId: ResultKeyPrefixProperties,
        @field:Valid @field:NotNull val flow: FlowProperties,
        @field:Valid @field:NotNull val readToken: RedisKeyPrefixProperties,
        @field:Valid @field:NotNull val writeToken: RedisKeyPrefixProperties,
    )

    data class RedisKeyPrefixProperties(@field:NotBlank val redisKeyPrefix: String)

    data class ResultKeyPrefixProperties(@field:NotBlank val resultKeyPrefix: String)

    data class FlowProperties(@field:Valid @field:NotNull val randomKey: RandomKeyProperties, @field:Min(1) val timeoutSec: Long) {
        data class RandomKeyProperties(@field:Min(1) val maxRetries: Int)
    }
}
