package com.plugin.config

import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jose.jwk.source.ImmutableJWKSet
import com.nimbusds.jose.jwk.source.JWKSource
import com.nimbusds.jose.proc.SecurityContext
import com.plugin.config.properties.JwtProperties
import java.security.KeyFactory
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.io.ResourceLoader
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.method.configuration.EnableReactiveMethodSecurity
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity
import org.springframework.security.config.web.server.ServerHttpSecurity
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.server.resource.web.server.authentication.ServerBearerTokenAuthenticationConverter
import org.springframework.security.web.server.SecurityWebFilterChain

@Configuration
@EnableWebFluxSecurity
@EnableReactiveMethodSecurity
class SecurityConfig(private val jwtProperties: JwtProperties, private val resourceLoader: ResourceLoader) {

    @Bean
    fun securityWebFilterChain(http: ServerHttpSecurity): SecurityWebFilterChain {
        return http
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
            .oauth2ResourceServer { oauth2 -> oauth2.bearerTokenConverter(bearerTokenConverter()).jwt {} }
            .build()
    }

    @Bean
    fun bearerTokenConverter(): ServerBearerTokenAuthenticationConverter {
        val converter = ServerBearerTokenAuthenticationConverter()
        converter.setAllowUriQueryParameter(true)
        return converter
    }

    @Bean
    fun jwtDecoder(): ReactiveJwtDecoder {
        val publicKey = loadPublicKey()
        return NimbusReactiveJwtDecoder.withPublicKey(publicKey).build()
    }

    @Bean fun publicKey(): RSAPublicKey = loadPublicKey()

    @Bean fun privateKey(): RSAPrivateKey = loadPrivateKey()

    @Bean
    fun jwkSource(publicKey: RSAPublicKey, privateKey: RSAPrivateKey): JWKSource<SecurityContext> {
        val rsaKey = RSAKey.Builder(publicKey).privateKey(privateKey).keyID("ux-plugin").build()
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
