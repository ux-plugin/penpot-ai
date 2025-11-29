package com.plugin.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "agent")
@Validated
data class AgentProperties(@field:Valid @field:NotNull val model: ModelProperties) {
    data class ModelProperties(@field:NotBlank val name: String)
}
