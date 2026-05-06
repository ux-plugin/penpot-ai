package com.plugin.api.config.ai

import com.plugin.api.config.properties.FigmaDesignAgentProperties
import dev.langchain4j.model.anthropic.AnthropicChatModel
import dev.langchain4j.model.anthropic.AnthropicStreamingChatModel
import dev.langchain4j.model.chat.ChatModel
import dev.langchain4j.model.chat.StreamingChatModel
import dev.langchain4j.model.googleai.GoogleAiGeminiChatModel
import dev.langchain4j.model.googleai.GoogleAiGeminiStreamingChatModel
import dev.langchain4j.model.openai.OpenAiChatModel
import dev.langchain4j.model.openai.OpenAiStreamingChatModel
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class FigmaDesignModelProvider(private val properties: FigmaDesignAgentProperties) {
    @Bean
    @Qualifier("figmaDesignChatModel")
    fun figmaDesignChatModel(): ChatModel = when (properties.provider.lowercase()) {
        "openai" -> createOpenAiChatModel()
        "anthropic" -> createAnthropicChatModel()
        "gemini" -> createGeminiChatModel()
        else -> error("Unknown AI provider: ${properties.provider}. Supported providers: openai, anthropic, gemini")
    }

    @Bean
    @Qualifier("figmaDesignStreamingChatModel")
    fun figmaDesignStreamingChatModel(): StreamingChatModel = when (properties.provider.lowercase()) {
        "openai" -> createOpenAiStreamingChatModel()
        "anthropic" -> createAnthropicStreamingChatModel()
        "gemini" -> createGeminiStreamingChatModel()
        else -> error("Unknown AI provider: ${properties.provider}. Supported providers: openai, anthropic, gemini")
    }

    private fun createOpenAiChatModel(): ChatModel = OpenAiChatModel
        .builder()
        .apiKey(properties.openai.apiKey)
        .modelName(properties.openai.modelName)
        .apply {
            properties.openai.reasoningEffort?.let { reasoningEffort(it) }
            returnThinking(properties.openai.returnThinking)
            properties.openai.temperature?.let { temperature(it) }
            properties.openai.maxTokens?.let { maxTokens(it) }
        }.build()

    private fun createOpenAiStreamingChatModel(): StreamingChatModel = OpenAiStreamingChatModel
        .builder()
        .apiKey(properties.openai.apiKey)
        .modelName(properties.openai.modelName)
        .apply {
            properties.openai.reasoningEffort?.let { reasoningEffort(it) }
            returnThinking(properties.openai.returnThinking)
            properties.openai.temperature?.let { temperature(it) }
            properties.openai.maxTokens?.let { maxTokens(it) }
        }.build()

    private fun createAnthropicChatModel(): ChatModel {
        val shouldEnableThinking =
            properties.anthropic.temperature == null ||
                properties.anthropic.temperature == 1.0

        return AnthropicChatModel
            .builder()
            .apiKey(properties.anthropic.apiKey)
            .modelName(properties.anthropic.modelName)
            .apply {
                properties.anthropic.maxTokens?.let { maxTokens(it) }

                if (shouldEnableThinking) {
                    temperature(1.0)
                    returnThinking(true)
                    thinkingType("enabled")
                    properties.anthropic.thinkingBudgetTokens?.let { thinkingBudgetTokens(it) }
                } else {
                    properties.anthropic.temperature?.let { temperature(it) }
                }
            }.build()
    }

    private fun createAnthropicStreamingChatModel(): StreamingChatModel {
        val shouldEnableThinking =
            properties.anthropic.temperature == null ||
                properties.anthropic.temperature == 1.0

        return AnthropicStreamingChatModel
            .builder()
            .apiKey(properties.anthropic.apiKey)
            .modelName(properties.anthropic.modelName)
            .apply {
                properties.anthropic.maxTokens?.let { maxTokens(it) }

                if (shouldEnableThinking) {
                    temperature(1.0)
                    returnThinking(true)
                    thinkingType("enabled")
                    properties.anthropic.thinkingBudgetTokens?.let { thinkingBudgetTokens(it) }
                } else {
                    properties.anthropic.temperature?.let { temperature(it) }
                }
            }.build()
    }

    private fun createGeminiChatModel(): ChatModel = GoogleAiGeminiChatModel
        .builder()
        .apiKey(properties.gemini.apiKey)
        .modelName(properties.gemini.modelName)
        .apply {
            properties.gemini.temperature?.let { temperature(it) }
            properties.gemini.maxOutputTokens?.let { maxOutputTokens(it) }
        }.build()

    private fun createGeminiStreamingChatModel(): StreamingChatModel = GoogleAiGeminiStreamingChatModel
        .builder()
        .apiKey(properties.gemini.apiKey)
        .modelName(properties.gemini.modelName)
        .apply {
            properties.gemini.temperature?.let { temperature(it) }
            properties.gemini.maxOutputTokens?.let { maxOutputTokens(it) }
        }.build()
}
