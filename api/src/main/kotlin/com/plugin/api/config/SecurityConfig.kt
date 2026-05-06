package com.plugin.api.config

import com.plugin.api.config.properties.Auth0Properties
import com.plugin.api.features.auth.auth0.Auth0UserProvisioner
import com.plugin.api.features.auth.auth0.Auth0UserSyncAuthenticationManager
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.config.annotation.method.configuration.EnableReactiveMethodSecurity
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.server.resource.web.server.authentication.ServerBearerTokenAuthenticationConverter
import org.springframework.security.web.server.SecurityWebFilterChain

@Configuration
@EnableWebFluxSecurity
@EnableReactiveMethodSecurity
class SecurityConfig(private val auth0Properties: Auth0Properties) {
    @Bean
    fun securityWebFilterChain(
        http: ServerHttpSecurity,
        authManager: ObjectProvider<ReactiveAuthenticationManager>,
    ): SecurityWebFilterChain {
        val chain = http
            .csrf { it.disable() }
            .cors {}
            .authorizeExchange { exchanges ->
                exchanges
                    .pathMatchers(HttpMethod.OPTIONS, "/**")
                    .permitAll()
                    .pathMatchers("/openapi/**", "/swagger-ui.html", "/swagger-ui/**", "/webjars/**", "/v3/api-docs/**")
                    .permitAll()
                    .pathMatchers("/auth/**")
                    .permitAll()
                    .pathMatchers("/dev/**")
                    .permitAll()
                    .anyExchange()
                    .authenticated()
            }
        val manager = authManager.getIfAvailable()
        if (manager != null) {
            chain.oauth2ResourceServer { oauth2 ->
                oauth2
                    .bearerTokenConverter(bearerTokenConverter())
                    .jwt { it.authenticationManager(manager) }
            }
        }
        return chain.build()
    }

    @Bean
    fun bearerTokenConverter(): ServerBearerTokenAuthenticationConverter {
        val converter = ServerBearerTokenAuthenticationConverter()
        converter.setAllowUriQueryParameter(true)
        return converter
    }

    @Bean("auth0JwtDecoder")
    @ConditionalOnProperty(prefix = "auth0", name = ["issuer"])
    fun auth0JwtDecoderBean(): ReactiveJwtDecoder = auth0JwtDecoder(auth0Properties)

    /**
     * Single Auth0-backed authentication manager. The plugin issues identities only via Auth0;
     * the legacy self-hosted JWT issuer was retired with figma_plugin_api#41.
     */
    @Bean
    @ConditionalOnProperty(prefix = "auth0", name = ["issuer"])
    fun auth0AuthenticationManager(
        @Qualifier("auth0JwtDecoder") auth0Decoder: ReactiveJwtDecoder,
        auth0UserProvisioner: Auth0UserProvisioner,
    ): ReactiveAuthenticationManager = Auth0UserSyncAuthenticationManager(auth0Decoder, auth0UserProvisioner)
}
