package com.plugin.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "jwt")
@Validated
data class JwtProperties(
    @field:NotBlank val privateKeyLocation: String,
    @field:NotBlank val publicKeyLocation: String,
    @field:Valid @field:NotNull val token: TokenProperties,
) {
    data class TokenProperties(@field:Min(1) val lifespan: Long)
}
