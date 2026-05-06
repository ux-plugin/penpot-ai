package com.plugin.api.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "rest-client")
@Validated
data class RestClientProperties(
    @field:Valid @field:NotNull val aiServer: ServerProperties,
    @field:Valid @field:NotNull val githubApi: ServerProperties,
    @field:Valid @field:NotNull val fireworksApi: FireworksApiProperties,
) {
    data class ServerProperties(@field:NotBlank val url: String)

    data class FireworksApiProperties(
        @field:NotBlank val url: String,
        @field:Min(1) val connectTimeout: Long,
        @field:Min(1) val readTimeout: Long,
    )
}
