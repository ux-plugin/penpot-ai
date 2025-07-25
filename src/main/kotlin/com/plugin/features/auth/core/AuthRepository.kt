package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.quarkus.logging.Log
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
    @ConfigProperty(name = "auth.access-token-ttl-s")
    private val accessTokenExpirationSeconds: Long,
    @ConfigProperty(name = "auth.refresh-token-ttl-s")
    private val refreshTokenExpirationSeconds: Long,
) : PanacheRepository<AuthUserEntity>, IAuthRepository {

    private val redis: ReactiveValueCommands<String, String> =
        reactiveRedisDataSource.value(String::class.java)
    private val accessTokenPrefix = "access_token:"


    @WithSession
    override fun getRefreshToken(userId: String): Uni<String> {
        return AuthUserEntity.find("id", userId).firstResult()
            .onItem().transformToUni { entity ->
                if (entity == null) {
                    Log.error("User not found with ID: $userId")
                    Uni.createFrom().failure(NotFoundException("User not found with ID: $userId"))
                } else if (entity.refreshToken.isNotEmpty() && entity.refreshTokenExpiresAt.isAfter(Instant.now())) {
                    Uni.createFrom().item(entity.refreshToken)
                } else {
                    Uni.createFrom().failure(SecurityException("Invalid or expired refresh token"))
                }
            }
    }

    /**
     * Creates both access and refresh tokens for a user
     */
    override fun createTokensForUser(id: String, username: String, role: UserRole): Uni<LoginCredentials> {
        return createAccessToken(id, username, role)
            .flatMap { accessToken ->
                createRefreshToken(id)
                    .map { refreshTokenInfo ->
                        LoginCredentials(
                            accessToken = accessToken,
                            refreshToken = refreshTokenInfo.refreshToken,
                            refreshTokenExpiresAt = refreshTokenInfo.expiresAt,
                        )
                    }
            }
    }

    /**
     * Creates an access token for a user
     */
    private fun createAccessToken(id: String, username: String, role: UserRole): Uni<String> {
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
                    .claim("role", role)
                    .issuedAt(now.epochSecond)
                    .expiresAt(exp.epochSecond)
                    .sign()

                redis.setex(accessTokenKey, accessTokenExpirationSeconds, token)
                    .replaceWith(token)
            }
        }
    }

    @WithSession
    fun createRefreshToken(userId: String): Uni<RefreshTokenInfo> {
        val refreshToken = UUID.randomUUID().toString()
        val refreshTokenExpiresAt = Instant.now().plusSeconds(refreshTokenExpirationSeconds)

        return withTransaction {
            AuthUserEntity.find("id", userId).firstResult()
                .onItem().ifNull().failWith(NotFoundException("User not found with ID: $userId"))
                .onItem().transformToUni { entity ->
                    if (entity != null) {
                        entity.refreshToken = refreshToken
                        entity.refreshTokenExpiresAt = refreshTokenExpiresAt
                        AuthUserEntity.persist(entity).map { RefreshTokenInfo(refreshToken, refreshTokenExpiresAt) }
                    } else {
                        Log.error("User not found with ID: $userId")
                        Uni.createFrom().failure(NotFoundException("User not found with ID: $userId"))
                    }
                }
        }
    }

    @WithSession
    override fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): Uni<String> {
        return AuthUserEntity.find("id", refreshTokenRequest.userId).firstResult()
            .onItem().transformToUni { entity ->
                if (entity == null) {
                    Log.error("User not found with ID: ${refreshTokenRequest.userId}")
                    Uni.createFrom().failure(NotFoundException("User not found with ID: ${refreshTokenRequest.userId}"))
                } else if (entity.refreshToken == refreshTokenRequest.refreshToken
                    && entity.refreshTokenExpiresAt.isAfter(Instant.now())
                ) {
                    createAccessToken(
                        id = entity.id,
                        username = entity.username,
                        role = entity.role
                    )
                } else {
                    Uni.createFrom().failure(SecurityException("Invalid or expired refresh token"))
                }
            }
    }

    @WithSession
    override fun getOrAddUser(username: String): Uni<AuthUserEntity> {
        return withTransaction {
            AuthUserEntity.find("username", username).firstResult()
                .onItem().transformToUni { existingUser ->
                    if (existingUser != null) {
                        // User already exists, return the user ID
                        Uni.createFrom().item(existingUser)
                    } else {
                        // Create a new user
                        val newUser = AuthUserEntity().apply {
                            this.username = username
                            this.role = UserRole.USER // Default role
                        }
                        AuthUserEntity.persist(newUser).map { newUser }
                    }
                }
        }
    }

    @WithSession
    fun getUser(id: String): Uni<AuthUserEntity> {
        return withTransaction {
            AuthUserEntity.find("id", id).firstResult()
                .onItem().ifNull().failWith(NotFoundException("User not found with ID: $id"))
                .onItem().transform { it }
        }
    }

    @WithSession
    override fun upsertSocialLogin(
        provider: SocialProvider,
        refreshToken: String,
        userId: String,
        refreshTokenExpiresAt: Instant
    ): Uni<Unit> {
        return withTransaction {
            AuthUserEntity.find("id", userId)
                .firstResult().onItem().ifNull().failWith(NotFoundException("User not found with ID: $userId"))
                .onItem().transformToUni { existingUser ->
                    SocialLoginEntity.find("userId = ?1 and provider = ?2", userId, provider)
                        .firstResult()
                        .onItem().transformToUni { existingSocialLogin ->
                            if (existingSocialLogin != null) {
                                existingSocialLogin.refreshToken = refreshToken
                                existingSocialLogin.refreshTokenExpiresAt = refreshTokenExpiresAt
                                SocialLoginEntity.persist(existingSocialLogin)
                            } else {
                                val newSocialLoginEntity = SocialLoginEntity().apply {
                                    this.provider = provider
                                    this.refreshToken = refreshToken
                                    this.userId = userId
                                    this.refreshTokenExpiresAt = refreshTokenExpiresAt
                                }
                                SocialLoginEntity.persist(newSocialLoginEntity)
                            }
                        }.map { it }.replaceWith(Unit)
                }

        }.replaceWith(Unit)
    }
}