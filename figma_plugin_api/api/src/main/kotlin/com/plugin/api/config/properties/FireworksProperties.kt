package com.plugin.api.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "fireworks")
@Validated
data class FireworksProperties(
    @field:Valid @field:NotNull val api: ApiProperties,
    @field:Valid @field:NotNull val whisper: WhisperProperties,
) {
    data class ApiProperties(@field:NotBlank val key: String, @field:NotBlank val baseUrl: String)

    data class WhisperProperties(@field:NotBlank val model: String)
}
