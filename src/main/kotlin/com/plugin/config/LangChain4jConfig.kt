package com.plugin.config

import dev.langchain4j.model.chat.ChatLanguageModel
import dev.langchain4j.model.chat.StreamingChatLanguageModel
import dev.langchain4j.model.openai.OpenAiChatModel
import dev.langchain4j.model.openai.OpenAiStreamingChatModel
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class LangChain4jConfig(
    @Value("\${openai.api.key}") private val openAiApiKey: String,
    @Value("\${agent.model.name}") private val modelName: String
) {
    
    @Bean
    fun chatLanguageModel(): ChatLanguageModel {
        return OpenAiChatModel.builder()
            .apiKey(openAiApiKey)
            .modelName(modelName)
            .temperature(0.7)
            .build()
    }
    
    @Bean
    fun streamingChatLanguageModel(): StreamingChatLanguageModel {
        return OpenAiStreamingChatModel.builder()
            .apiKey(openAiApiKey)
            .modelName(modelName)
            .temperature(0.7)
            .build()
    }
}
