package com.plugin.config

import com.plugin.config.properties.AgentProperties
import com.plugin.config.properties.OpenAiProperties
import dev.langchain4j.model.chat.ChatLanguageModel
import dev.langchain4j.model.chat.StreamingChatLanguageModel
import dev.langchain4j.model.openai.OpenAiChatModel
import dev.langchain4j.model.openai.OpenAiStreamingChatModel
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class LangChain4jConfig(private val openAiProperties: OpenAiProperties, private val agentProperties: AgentProperties) {

    @Bean
    fun chatLanguageModel(): ChatLanguageModel {
        return OpenAiChatModel.builder()
            .apiKey(openAiProperties.api.key)
            .modelName(agentProperties.model.name)
            .temperature(0.7)
            .build()
    }

    @Bean
    fun streamingChatLanguageModel(): StreamingChatLanguageModel {
        return OpenAiStreamingChatModel.builder()
            .apiKey(openAiProperties.api.key)
            .modelName(agentProperties.model.name)
            .temperature(0.7)
            .build()
    }
}
