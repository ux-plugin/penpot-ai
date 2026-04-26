package com.plugin.config

import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jose.jwk.source.ImmutableJWKSet
import com.nimbusds.jose.jwk.source.JWKSource
import com.nimbusds.jose.proc.SecurityContext
import com.plugin.config.properties.Auth0Properties
import com.plugin.config.properties.JwtProperties
import com.plugin.features.auth.auth0.Auth0UserProvisioner
import com.plugin.features.auth.auth0.Auth0UserSyncAuthenticationManager
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.ResourceLoader
import org.springframework.http.HttpMethod
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.authentication.ReactiveAuthenticationManagerResolver
import org.springframework.security.config.annotation.method.configuration.EnableReactiveMethodSecurity
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.server.resource.authentication.JwtReactiveAuthenticationManager
import org.springframework.security.oauth2.server.resource.web.server.authentication.ServerBearerTokenAuthenticationConverter
import org.springframework.security.web.server.SecurityWebFilterChain
import reactor.core.publisher.Mono
import java.security.KeyFactory
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.*

@Configuration
@EnableWebFluxSecurity
@EnableReactiveMethodSecurity
class SecurityConfig(
    private val jwtProperties: JwtProperties,
    private val auth0Properties: Auth0Properties,
    private val resourceLoader: ResourceLoader,
) {
    @Bean
    fun securityWebFilterChain(
        http: ServerHttpSecurity,
        issuerToManagerResolver: ReactiveAuthenticationManagerResolver<String>,
    ): SecurityWebFilterChain = http
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
        }.oauth2ResourceServer { oauth2 ->
            oauth2
                .bearerTokenConverter(bearerTokenConverter())
                .jwt { it.authenticationManager(MultiIssuerReactiveAuthenticationManager(issuerToManagerResolver)) }
        }.build()

    @Bean
    fun bearerTokenConverter(): ServerBearerTokenAuthenticationConverter {
        val converter = ServerBearerTokenAuthenticationConverter()
        converter.setAllowUriQueryParameter(true)
        return converter
    }

    @Bean("selfHostedJwtDecoder")
    fun selfHostedJwtDecoderBean(publicKey: RSAPublicKey): ReactiveJwtDecoder = selfHostedJwtDecoder(publicKey)

    @Bean("auth0JwtDecoder")
    @ConditionalOnProperty(prefix = "auth0", name = ["issuer"])
    fun auth0JwtDecoderBean(): ReactiveJwtDecoder = auth0JwtDecoder(auth0Properties)

    /**
     * Source of truth: a [ReactiveAuthenticationManagerResolver] keyed by JWT `iss` claim.
     * Reused for both HTTP and RSocket via [MultiIssuerReactiveAuthenticationManager].
     * The Auth0 entry is registered only when `auth0.issuer` is configured.
     */
    @Bean
    fun issuerToManagerResolver(
        @Qualifier("selfHostedJwtDecoder") selfHostedDecoder: ReactiveJwtDecoder,
        @Qualifier("auth0JwtDecoder") auth0Decoder: ObjectProvider<ReactiveJwtDecoder>,
        auth0UserProvisioner: ObjectProvider<Auth0UserProvisioner>,
    ): ReactiveAuthenticationManagerResolver<String> {
        val managers = buildMap<String, ReactiveAuthenticationManager> {
            put(SELF_HOSTED_ISSUER, JwtReactiveAuthenticationManager(selfHostedDecoder))
            val auth0 = auth0Decoder.getIfAvailable()
            if (auth0 != null && auth0Properties.issuer != null) {
                // Both auth0Decoder and Auth0UserProvisioner are gated on `auth0.issuer`, so if
                // we're in this branch the provisioner bean is required.
                val provisioner = auth0UserProvisioner.getObject()
                put(auth0Properties.issuer, Auth0UserSyncAuthenticationManager(auth0, provisioner))
            }
        }
        return ReactiveAuthenticationManagerResolver { issuer -> Mono.justOrEmpty(managers[issuer]) }
    }

    @Bean fun publicKey(): RSAPublicKey = loadPublicKey()

    @Bean fun privateKey(): RSAPrivateKey = loadPrivateKey()

    @Bean
    fun jwkSource(publicKey: RSAPublicKey, privateKey: RSAPrivateKey): JWKSource<SecurityContext> {
        val rsaKey =
            RSAKey
                .Builder(publicKey)
                .privateKey(privateKey)
                .keyID("ux-plugin")
                .build()
        return ImmutableJWKSet(JWKSet(rsaKey))
    }

    private fun loadPublicKey(): RSAPublicKey {
        val publicKeyResource = resourceLoader.getResource(jwtProperties.publicKeyLocation)
        val keyContent =
            publicKeyResource.inputStream
                .bufferedReader()
                .use { it.readText() }
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replace("\\s".toRegex(), "")

        val decoded = Base64.getDecoder().decode(keyContent)
        val spec = X509EncodedKeySpec(decoded)
        val keyFactory = KeyFactory.getInstance("RSA")
        return keyFactory.generatePublic(spec) as RSAPublicKey
    }

    private fun loadPrivateKey(): RSAPrivateKey {
        val privateKeyResource = resourceLoader.getResource(jwtProperties.privateKeyLocation)
        val keyContent =
            privateKeyResource.inputStream
                .bufferedReader()
                .use { it.readText() }
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replace("\\s".toRegex(), "")

        val decoded = Base64.getDecoder().decode(keyContent)
        val spec = PKCS8EncodedKeySpec(decoded)
        val keyFactory = KeyFactory.getInstance("RSA")
        return keyFactory.generatePrivate(spec) as RSAPrivateKey
    }
}
