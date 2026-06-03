package com.plugin.api.config.properties

import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.NotNull
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.cloud.context.config.annotation.RefreshScope
import org.springframework.validation.annotation.Validated

@ConfigurationProperties(prefix = "agent.figma-design")
@RefreshScope
@Validated
data class FigmaDesignAgentProperties(
    @field:NotBlank val provider: String,
    @field:Valid @field:NotNull val openai: OpenAiConfig,
    @field:Valid @field:NotNull val anthropic: AnthropicConfig,
    @field:Valid @field:NotNull val gemini: GeminiConfig,
) {
    data class OpenAiConfig(
        @field:NotBlank val apiKey: String,
        @field:NotBlank val modelName: String,
        val reasoningEffort: String? = "medium",
        val returnThinking: Boolean = true,
        val temperature: Double? = null,
        val maxTokens: Int? = null,
    )

    data class AnthropicConfig(
        @field:NotBlank val apiKey: String,
        @field:NotBlank val modelName: String,
        val maxTokens: Int? = 4096,
        val temperature: Double? = null,
        val thinkingBudgetTokens: Int? = 1000,
    )

    data class GeminiConfig(
        @field:NotBlank val apiKey: String,
        @field:NotBlank val modelName: String,
        val temperature: Double? = 0.7,
        val maxOutputTokens: Int? = null,
    )
}
