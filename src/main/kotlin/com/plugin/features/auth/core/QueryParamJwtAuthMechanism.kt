package com.plugin.features.auth.core

import io.quarkus.logging.Log
import io.quarkus.security.credential.TokenCredential
import io.quarkus.security.identity.IdentityProviderManager
import io.quarkus.security.identity.SecurityIdentity
import io.quarkus.security.identity.request.AuthenticationRequest
import io.quarkus.security.identity.request.TokenAuthenticationRequest
import io.quarkus.security.runtime.QuarkusSecurityIdentity
import io.quarkus.vertx.http.runtime.security.ChallengeData
import io.quarkus.vertx.http.runtime.security.HttpAuthenticationMechanism
import io.smallrye.jwt.auth.principal.JWTAuthContextInfo
import io.smallrye.jwt.auth.principal.JWTParser
import io.smallrye.jwt.auth.principal.ParseException
import io.smallrye.mutiny.Uni
import io.vertx.ext.web.RoutingContext
import jakarta.annotation.Priority
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import org.eclipse.microprofile.jwt.JsonWebToken

/**
 * Custom authentication mechanism that extracts JWT tokens from query parameters for WebSocket connections, while
 * allowing other requests to use the default Authorization header mechanism.
 *
 * This mechanism specifically handles the configured WebSocket endpoint, extracting the token from the configured query
 * parameter.
 */
@Priority(1000) // Run before default JWT mechanism (priority 2000)
@ApplicationScoped
class QueryParamJwtAuthMechanism
@Inject
constructor(
    private val jwtAuthContextInfo: JWTAuthContextInfo,
    private val jwtParser: JWTParser,
    private val config: WebSocketAuthConfig
) : HttpAuthenticationMechanism {

    override fun authenticate(
        context: RoutingContext,
        identityProviderManager: IdentityProviderManager
    ): Uni<SecurityIdentity> {
        // Only handle WebSocket upgrade requests to the configured path
        if (!isWebSocketRequest(context) || context.request().path() != config.path()) {
            // Not our concern - let default JWT mechanism handle it
            return Uni.createFrom().nullItem()
        }

        // Extract token from query parameter
        val token = extractTokenFromQuery(context)
        if (token == null) {
            Log.warn("WebSocket connection attempt without token query parameter")
            return Uni.createFrom().failure(RuntimeException("Missing token query parameter"))
        }

        // Validate JWT and create security identity
        return try {
            // Parse and validate the JWT token
            val jwtPrincipal = validateJwt(token)
            Log.info("Successfully validated JWT for user: ${jwtPrincipal.subject}")

            // Build SecurityIdentity directly from the validated JWT
            val identity =
                QuarkusSecurityIdentity.builder()
                    .setPrincipal(jwtPrincipal)
                    .addCredential(TokenCredential(token, "bearer"))
                    .addRoles(jwtPrincipal.groups ?: emptySet())
                    .build()

            Log.info("Successfully authenticated WebSocket connection for user: ${jwtPrincipal.subject}")
            Uni.createFrom().item(identity)
        } catch (e: ParseException) {
            Log.error("Invalid JWT token in query parameter", e)
            Uni.createFrom().failure(RuntimeException("Invalid JWT token", e))
        } catch (e: Exception) {
            Log.error("Error authenticating WebSocket connection", e)
            Uni.createFrom().failure(e)
        }
    }

    override fun getChallenge(context: RoutingContext): Uni<ChallengeData> {
        // For WebSocket connections, we don't send WWW-Authenticate challenges
        return Uni.createFrom().nullItem()
    }

    override fun getCredentialTypes(): MutableSet<Class<out AuthenticationRequest>> {
        return mutableSetOf(TokenAuthenticationRequest::class.java)
    }

    /** Checks if the request is a WebSocket upgrade request */
    private fun isWebSocketRequest(context: RoutingContext): Boolean {
        val upgradeHeader = context.request().getHeader(config.upgradeHeader())
        return upgradeHeader?.lowercase() == config.websocketValue()
    }

    /** Extracts the JWT token from the query parameter */
    private fun extractTokenFromQuery(context: RoutingContext): String? {
        return context.request().getParam(config.tokenQueryParam())
    }

    /** Validates the JWT token and returns the principal */
    private fun validateJwt(token: String): JsonWebToken {
        return jwtParser.parse(token)
    }
}
