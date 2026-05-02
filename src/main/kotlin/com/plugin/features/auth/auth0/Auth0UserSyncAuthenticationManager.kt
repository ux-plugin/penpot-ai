package com.plugin.features.auth.auth0

import kotlinx.coroutines.reactor.mono
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.core.Authentication
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.security.oauth2.server.resource.authentication.JwtReactiveAuthenticationManager
import reactor.core.publisher.Mono

/**
 * Decorates the Auth0 [JwtReactiveAuthenticationManager] with a post-authentication step that
 * provisions (or backfills) the local users row from the Auth0 JWT.
 *
 * Modeled as an authentication-success hook rather than a separate `WebFilter` so the same code
 * path covers HTTP requests and RSocket setup-frame authentication — both go through the
 * issuer-keyed manager resolver wired in `SecurityConfig`/`RSocketSecurityConfig`.
 */
class Auth0UserSyncAuthenticationManager(auth0Decoder: ReactiveJwtDecoder, private val provisioner: Auth0UserProvisioner) :
    ReactiveAuthenticationManager {
    private val delegate = JwtReactiveAuthenticationManager(auth0Decoder)

    override fun authenticate(authentication: Authentication): Mono<Authentication> =
        delegate.authenticate(authentication).flatMap { auth ->
            val jwt = (auth as JwtAuthenticationToken).token
            mono { provisioner.ensureUser(jwt) }.thenReturn(auth)
        }
}
