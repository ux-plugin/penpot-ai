package com.plugin.features.auth

import com.plugin.features.user.UserRoles
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.value.ReactiveValueCommands
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import org.eclipse.microprofile.config.inject.ConfigProperty
import java.time.Instant
import java.util.*

@ApplicationScoped
class AuthRepository(
    reactiveRedisDataSource: ReactiveRedisDataSource,
    @ConfigProperty(name = "redis.access-token-expiration", defaultValue = "900")
    private val accessTokenExpirationSeconds: Long,
    @ConfigProperty(name = "redis.refresh-token-expiration", defaultValue = "2592000")
    private val refreshTokenExpirationSeconds: Long
) : PanacheRepository<AuthEntity>, IAuthRepository {

    private val redis: ReactiveValueCommands<String, String> =
        reactiveRedisDataSource.value(String::class.java)
    private val accessTokenPrefix = "access_token:"
    private val refreshTokenPrefix = "refresh_token:"

    override fun authenticate(username: String, password: String): Uni<LoginCredentials> {
        return AuthEntity.find("username", username)
            .firstResult()
            .onItem().ifNull().failWith(NotFoundException("User not found with username: $username"))
            .onItem().transformToUni { entity ->
                if (entity == null || entity.password != password) {
                    Uni.createFrom().failure(SecurityException("Invalid password"))
                } else {
                    createTokensForUser(
                        id = entity.id,
                        username = entity.username,
                        role = entity.role
                    )
                }
            }
    }

    override fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): Uni<String> {
        return validateRefreshToken(refreshTokenRequest)
            .onItem().transformToUni { token ->
                AuthEntity.find("id", refreshTokenRequest.userId)
                    .firstResult()
                    .onItem().ifNull()
                    .failWith(NotFoundException("User not found with ID: ${refreshTokenRequest.userId}"))
                    .onItem().transformToUni { entity ->
                        if (entity == null) {
                            Uni.createFrom().failure(SecurityException("Invalid refresh token"))
                        } else {
                            createAccessToken(
                                id = entity.id,
                                username = entity.username,
                                role = entity.role
                            )
                        }
                    }
            }
    }

    override fun validateRefreshToken(refreshTokenRequest: RefreshTokenRequest): Uni<String> {
        val refreshTokenKey = refreshTokenPrefix + refreshTokenRequest.userId
        return redis.get(refreshTokenKey)
            .onItem().ifNull().failWith(SecurityException("Invalid or expired refresh token"))
    }

    /**
     * Creates both access and refresh tokens for a user
     */
    private fun createTokensForUser(id: String, username: String, role: UserRoles): Uni<LoginCredentials> {
        return createAccessToken(id, username, role)
            .flatMap { accessToken ->
                createRefreshToken(id)
                    .map { refreshToken ->
                        LoginCredentials(
                            accessToken = accessToken,
                            refreshToken = refreshToken
                        )
                    }
            }
    }

    /**
     * Creates an access token for a user
     */
    private fun createAccessToken(id: String, username: String, role: UserRoles): Uni<String> {
        val accessTokenKey = accessTokenPrefix + username

        // Attempt to get an existing token first
        return redis.get(accessTokenKey).flatMap { existingToken ->
            if (existingToken != null) {
                // Token already exists and is valid
                Uni.createFrom().item(existingToken)
            } else {
                // No token found, create a new one
                val now = Instant.now()
                val exp = now.plusSeconds(accessTokenExpirationSeconds)
                val token = Jwt.issuer("ux-plugin")
                    .subject(id)
                    .upn(username)
                    .claim("role", role.value)
                    .issuedAt(now.epochSecond)
                    .expiresAt(exp.epochSecond)
                    .sign()

                redis.setex(accessTokenKey, accessTokenExpirationSeconds, token)
                    .replaceWith(token)
            }
        }
    }

    /**
     * Creates a refresh token for a user
     */
    private fun createRefreshToken(userId: String): Uni<String> {
        val refreshToken = UUID.randomUUID().toString()
        val refreshTokenKey = refreshTokenPrefix + userId

        // Store the refresh token with the user ID
        return redis.get(refreshTokenKey).flatMap { existingToken ->
            if (existingToken != null) {
                Uni.createFrom().item(existingToken)
            } else {
                redis.setex(refreshTokenKey, refreshTokenExpirationSeconds, refreshToken)
                    .replaceWith(refreshToken)
            }
        }

    }
}