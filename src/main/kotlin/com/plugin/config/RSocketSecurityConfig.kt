package com.plugin.config

import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.config.annotation.rsocket.EnableRSocketSecurity
import org.springframework.security.config.annotation.rsocket.RSocketSecurity
import org.springframework.security.rsocket.core.PayloadSocketAcceptorInterceptor

@Configuration
@EnableRSocketSecurity
class RSocketSecurityConfig {
    @Bean
    fun rsocketAuth(
        security: RSocketSecurity,
        authManager: ObjectProvider<ReactiveAuthenticationManager>,
    ): PayloadSocketAcceptorInterceptor {
        val configured = security
            .authorizePayload { authz ->
                authz
                    .route("auth.**")
                    .permitAll()
                    .anyRequest()
                    .authenticated()
                    .anyExchange()
                    .permitAll()
            }
        val manager = authManager.getIfAvailable()
        if (manager != null) {
            configured.jwt { jwt -> jwt.authenticationManager(manager) }
        }
        return configured.build()
    }
}
