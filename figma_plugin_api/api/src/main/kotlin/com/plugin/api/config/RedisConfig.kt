package com.plugin.api.config

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.api.features.user.PortState
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.core.ReactiveRedisTemplate
import org.springframework.data.redis.serializer.Jackson2JsonRedisSerializer
import org.springframework.data.redis.serializer.RedisSerializationContext
import org.springframework.data.redis.serializer.StringRedisSerializer

@Configuration
class RedisConfig {
    @Bean
    fun reactiveRedisTemplate(connectionFactory: ReactiveRedisConnectionFactory): ReactiveRedisTemplate<String, String> {
        val serializationContext =
            RedisSerializationContext
                .newSerializationContext<String, String>(StringRedisSerializer())
                .hashKey(StringRedisSerializer())
                .hashValue(StringRedisSerializer())
                .build()

        return ReactiveRedisTemplate(connectionFactory, serializationContext)
    }

    @Bean
    fun portStateRedisTemplate(
        connectionFactory: ReactiveRedisConnectionFactory,
        objectMapper: ObjectMapper,
    ): ReactiveRedisTemplate<String, PortState> {
        val serializer = Jackson2JsonRedisSerializer(objectMapper, PortState::class.java)
        val serializationContext =
            RedisSerializationContext
                .newSerializationContext<String, PortState>(StringRedisSerializer())
                .value(serializer)
                .hashValue(serializer)
                .build()

        return ReactiveRedisTemplate(connectionFactory, serializationContext)
    }
}
