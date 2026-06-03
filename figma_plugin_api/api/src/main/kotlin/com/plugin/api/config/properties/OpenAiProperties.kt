package com.plugin.api.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "openai")
@Validated
data class OpenAiProperties(
    @field:Valid @field:NotNull val api: ApiProperties,
    @field:Valid @field:NotNull val project: ProjectProperties,
    @field:Valid @field:NotNull val org: OrgProperties,
) {
    data class ApiProperties(@field:NotBlank val key: String)

    data class ProjectProperties(@field:NotBlank val id: String)

    data class OrgProperties(@field:NotBlank val id: String)
}
