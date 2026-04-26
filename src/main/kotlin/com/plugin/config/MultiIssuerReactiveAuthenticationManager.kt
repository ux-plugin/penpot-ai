package com.plugin.config

import com.nimbusds.jwt.JWTParser
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.authentication.ReactiveAuthenticationManagerResolver
import org.springframework.security.core.Authentication
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException
import org.springframework.security.oauth2.server.resource.authentication.BearerTokenAuthenticationToken
import reactor.core.publisher.Mono

class MultiIssuerReactiveAuthenticationManager(private val resolver: ReactiveAuthenticationManagerResolver<String>) :
    ReactiveAuthenticationManager {
    override fun authenticate(authentication: Authentication): Mono<Authentication> {
        val token = (authentication as? BearerTokenAuthenticationToken)?.token
            ?: return Mono.error(InvalidBearerTokenException("Bearer token required"))

        val issuer = runCatching { JWTParser.parse(token).jwtClaimsSet.issuer }
            .getOrNull()
            ?: return Mono.error(InvalidBearerTokenException("JWT missing iss claim"))

        return resolver
            .resolve(issuer)
            .switchIfEmpty(Mono.error(InvalidBearerTokenException("Untrusted JWT issuer: $issuer")))
            .flatMap { it.authenticate(authentication) }
    }
}
