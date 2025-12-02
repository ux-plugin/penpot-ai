package com.plugin.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.config.annotation.rsocket.EnableRSocketSecurity
import org.springframework.security.config.annotation.rsocket.RSocketSecurity
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.server.resource.authentication.JwtReactiveAuthenticationManager
import org.springframework.security.rsocket.core.PayloadSocketAcceptorInterceptor

@Configuration
@EnableRSocketSecurity
class RSocketSecurityConfig(private val jwtDecoder: ReactiveJwtDecoder) {
    @Bean
    fun rsocketAuth(security: RSocketSecurity): PayloadSocketAcceptorInterceptor = security
        .authorizePayload { authz ->
            authz
                .route("auth.**")
                .permitAll()
                .anyRequest()
                .authenticated()
                .anyExchange()
                .permitAll()
        }.jwt { jwt -> jwt.authenticationManager(JwtReactiveAuthenticationManager(jwtDecoder)) }
        .build()
}
