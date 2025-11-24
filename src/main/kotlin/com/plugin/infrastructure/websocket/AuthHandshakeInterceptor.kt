package com.plugin.infrastructure.websocket

import kotlinx.coroutines.reactor.mono
import org.springframework.http.HttpStatus
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.stereotype.Component
import org.springframework.web.reactive.socket.WebSocketHandler
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import java.time.Instant

/**
 * Authentication interceptor for WebSocket handshake
 * Validates JWT token before allowing WebSocket connection
 */
@Component
class AuthHandshakeInterceptor(
    private val jwtDecoder: ReactiveJwtDecoder
) {

    companion object {
        const val USER_ID_ATTRIBUTE = "userId"
        const val JWT_EXPIRATION_ATTRIBUTE = "jwtExpiration"
    }

    /**
     * Validates JWT token from query parameter and stores user info in session attributes
     * Returns true if authentication succeeds, false otherwise
     */
    fun authenticate(session: WebSocketSession): Mono<Boolean> {
        return mono {
            try {
                // Extract token from query parameter
                val token = session.handshakeInfo.uri.query
                    ?.split("&")
                    ?.find { it.startsWith("token=") }
                    ?.substringAfter("token=")

                if (token.isNullOrBlank()) {
                    return@mono false
                }

                // Validate JWT
                val jwt = try {
                    jwtDecoder.decode(token).block()
                } catch (e: Exception) {
                    println("JWT validation failed: ${e.message}")
                    return@mono false
                }

                if (jwt == null) {
                    return@mono false
                }

                val userId = jwt.subject
                val expirationTime = jwt.expiresAt

                // Check if token is expired
                if (userId.isNullOrBlank() || expirationTime == null || expirationTime.isBefore(Instant.now())) {
                    println("Token expired or invalid user ID")
                    return@mono false
                }

                // Store user information in session attributes
                session.attributes[USER_ID_ATTRIBUTE] = userId
                session.attributes[JWT_EXPIRATION_ATTRIBUTE] = expirationTime

                true
            } catch (e: Exception) {
                println("Authentication error: ${e.message}")
                false
            }
        }
    }

    /**
     * Retrieves user ID from session attributes
     */
    fun getUserId(session: WebSocketSession): String? {
        return session.attributes[USER_ID_ATTRIBUTE] as? String
    }

    /**
     * Retrieves JWT expiration time from session attributes
     */
    fun getExpiration(session: WebSocketSession): Instant? {
        return session.attributes[JWT_EXPIRATION_ATTRIBUTE] as? Instant
    }
}
