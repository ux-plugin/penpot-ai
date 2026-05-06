package com.plugin.api.dev

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile
import org.springframework.core.annotation.Order
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.web.server.SecurityWebFilterChain
import org.springframework.security.web.server.util.matcher.ServerWebExchangeMatchers

@Configuration
@Profile("dev")
class SecurityConfigDev {
    @Bean
    @Order(0) // Higher priority than default SecurityConfig
    fun actuatorSecurityWebFilterChain(http: ServerHttpSecurity): SecurityWebFilterChain = http
        .securityMatcher(ServerWebExchangeMatchers.pathMatchers("/actuator/**"))
        .csrf { it.disable() }
        .authorizeExchange { exchanges -> exchanges.anyExchange().permitAll() }
        .build()
}
