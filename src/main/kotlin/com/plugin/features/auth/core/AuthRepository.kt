package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.quarkus.logging.Log
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotAllowedException
import jakarta.ws.rs.NotFoundException
import java.time.Instant
import java.util.*
import org.eclipse.microprofile.config.inject.ConfigProperty

@ApplicationScoped
class AuthRepository(
    @ConfigProperty(name = "auth.access-token-ttl-s") private val accessTokenExpirationSeconds: Long,
    @ConfigProperty(name = "auth.refresh-token-ttl-s") private val refreshTokenExpirationSeconds: Long,
) : PanacheRepository<AuthUserEntity> {

    @WithSession
    fun getRefreshToken(userId: String): Uni<FigmaPluginGetRefreshTokenResponse> {
        return AuthUserEntity.find("id", userId).firstResult().onItem().transformToUni { entity ->
            if (entity == null) {
                Log.error("User not found with ID: $userId")
                Uni.createFrom().failure(NotFoundException("User not found with ID: $userId"))
            } else if (entity.refreshToken.isNotEmpty() && entity.refreshTokenExpiresAt.isAfter(Instant.now())) {
                Uni.createFrom()
                    .item(FigmaPluginGetRefreshTokenResponse(entity.refreshToken, entity.refreshTokenExpiresAt))
            } else {
                Uni.createFrom().failure(SecurityException("Invalid or expired refresh token"))
            }
        }
    }

    /** Creates both access and refresh tokens for a user */
    fun createTokensForUser(id: String, role: UserRole): Uni<LoginCredentials> {
        return createAccessToken(id, role).flatMap { accessToken ->
            createRefreshToken(id).map { refreshTokenInfo ->
                LoginCredentials(
                    accessToken = accessToken,
                    refreshToken = refreshTokenInfo.refreshToken,
                    refreshTokenExpiresAt = refreshTokenInfo.expiresAt,
                )
            }
        }
    }

    /** Creates an access token for a user */
    private fun createAccessToken(id: String, role: UserRole): Uni<String> {
        val now = Instant.now()
        val exp = now.plusSeconds(accessTokenExpirationSeconds)

        return Uni.createFrom()
            .item(
                Jwt.claims()
                    .issuer("ux-plugin")
                    .subject(id)
                    .claim("role", role)
                    .issuedAt(now.epochSecond)
                    .expiresAt(exp.epochSecond)
                    .sign()
            )
    }

    @WithSession
    fun createRefreshToken(userId: String): Uni<RefreshTokenInfo> {
        val refreshToken = UUID.randomUUID().toString()
        val refreshTokenExpiresAt = Instant.now().plusSeconds(refreshTokenExpirationSeconds)

        return withTransaction {
            AuthUserEntity.find("id", userId)
                .firstResult()
                .onItem()
                .ifNull()
                .failWith(NotFoundException("User not found with ID: $userId"))
                .onItem()
                .transformToUni { entity ->
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
    fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): Uni<String> {
        return AuthUserEntity.find(
                "id = ?1 and refreshToken = ?2",
                refreshTokenRequest.userId,
                refreshTokenRequest.refreshToken,
            )
            .firstResult()
            .onItem()
            .transformToUni { entity ->
                if (entity == null || entity.refreshTokenExpiresAt.isAfter(Instant.now())) {
                    Log.error("User not found with ID: ${refreshTokenRequest.userId}")
                    Uni.createFrom()
                        .failure(
                            SecurityException(
                                "Invalid or expired refresh token for user with ID: ${refreshTokenRequest.userId}"
                            )
                        )
                } else {
                    createAccessToken(id = entity.id, role = entity.role)
                }
            }
    }

    @WithSession
    fun addUser(): Uni<AuthUserEntity> {
        return withTransaction {
            val newUser =
                AuthUserEntity().apply {
                    this.role = UserRole.USER // Default role
                }
            AuthUserEntity.persist(newUser).map { newUser }
        }
    }

    @WithSession
    fun getSocialLogin(
        providerUserId: String,
        provider: SocialProvider,
    ): Uni<SocialLoginEntity?> {
        return withTransaction {
            SocialLoginEntity.find(
                    "providerUserId = ?1 and provider = ?2",
                    providerUserId,
                    provider,
                )
                .firstResult()
                .onItem()
                .transform { it }
        }
    }

    @WithSession
    fun updateSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String?,
        refreshTokenExpiresAt: Instant?,
    ): Uni<Unit> {
        return withTransaction {
            SocialLoginEntity.find(
                    "providerUserId = ?1 and provider = ?2",
                    providerUserId,
                    provider,
                )
                .firstResult()
                .onItem()
                .transform { entity ->
                    if (entity != null) {
                        // Update only the non-null fields
                        if (refreshToken != null) {
                            entity.refreshToken = refreshToken
                        }
                        if (refreshTokenExpiresAt != null) {
                            entity.refreshTokenExpiresAt = refreshTokenExpiresAt
                        }

                        // Persist the updated entity
                        SocialLoginEntity.persist(entity)
                    } else {
                        Uni.createFrom().failure(NotFoundException("Social login not found for user: $providerUserId"))
                    }
                }
                .replaceWith(Unit)
        }
    }

    @WithSession
    fun insertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
        main: Boolean = false,
    ): Uni<SocialLoginEntity> {
        return withTransaction {
            AuthUserEntity.find("id", userId)
                .firstResult()
                .onItem()
                .ifNull()
                .failWith(NotFoundException("User $userId not found"))
                .flatMap { user ->
                    val socialLoginEntity =
                        SocialLoginEntity().apply {
                            this.userId = userId
                            this.provider = provider
                            this.providerUserId = providerUserId
                            this.refreshToken = refreshToken
                            this.refreshTokenExpiresAt = refreshTokenExpiresAt
                            this.main = main
                        }
                    SocialLoginEntity.persist(socialLoginEntity).map { socialLoginEntity }
                }
        }
    }

    @WithSession
    fun upsertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
    ): Uni<Unit> {
        return withTransaction {
                getSocialLogin(providerUserId, provider).flatMap { socialLoginEntity ->
                    if (socialLoginEntity == null) {
                        insertSocialLogin(
                            provider,
                            providerUserId,
                            refreshToken,
                            refreshTokenExpiresAt,
                            userId,
                        )
                    } else {
                        updateSocialLogin(
                            provider,
                            providerUserId,
                            refreshToken,
                            refreshTokenExpiresAt,
                        )
                    }
                }
            }
            .replaceWith(Unit)
    }

    @WithSession
    fun deleteSocialLogin(userId: String, socialLoginId: String): Uni<Unit> {
        return withTransaction {
            SocialLoginEntity.find("userId = ?1 and id = ?2", userId, socialLoginId)
                .firstResult()
                .onItem()
                .transformToUni { entity ->
                    if (entity == null) {
                        Uni.createFrom().failure(NotFoundException("Social login not found for user: $userId"))
                    } else if (entity.main) {
                        Uni.createFrom().failure(NotAllowedException("Cannot delete main social login"))
                    } else {
                        SocialLoginEntity.deleteById(socialLoginId)
                    }
                }
                .replaceWith(Unit)
        }
    }

    @WithSession
    fun associateUserWithSocialProvider(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String? = null,
    ): Uni<AuthUserEntity> {
        return withTransaction {
            getSocialLogin(providerUserId, provider).flatMap { socialLoginEntity ->
                if (socialLoginEntity != null) {
                    // Case 1: Social login exists. Return the associated user and update the
                    // refresh token.
                    Log.debug(
                        "Social login found for provider: $provider, providerUserId: $providerUserId. Updating refresh token and expiresAt."
                    )
                    updateSocialLogin(
                            provider = provider,
                            providerUserId = providerUserId,
                            refreshToken = refreshToken,
                            refreshTokenExpiresAt = refreshTokenExpiresAt,
                        )
                        .flatMap {
                            // After updating, retrieve and return the user associated with this
                            // social login
                            AuthUserEntity.find("id", socialLoginEntity.userId).firstResult().onItem().transformToUni {
                                user ->
                                if (user == null) {
                                    Uni.createFrom().failure {
                                        NotFoundException(
                                            "Associated user not found for social login with ID: ${socialLoginEntity.id}"
                                        )
                                    }
                                } else {
                                    Uni.createFrom().item(user)
                                }
                            }
                        }
                } else {
                    // Case 2: Social login does not exist.
                    if (userId != null) {
                        // Case 2a: An existing userId is provided. Associate the new social login
                        // with this
                        // user.
                        Log.debug(
                            "Social login not found, but userId is provided ($userId). Associating with this existing user."
                        )
                        AuthUserEntity.find("id", userId).firstResult().flatMap { user ->
                            if (user == null) {
                                Uni.createFrom().failure { NotFoundException("User $userId not found") }
                            } else {
                                insertSocialLogin(
                                        provider = provider,
                                        providerUserId = providerUserId,
                                        refreshToken = refreshToken,
                                        refreshTokenExpiresAt = refreshTokenExpiresAt,
                                        userId = user.id,
                                    )
                                    .map { user }
                            }
                        }
                    } else {
                        // Case 2b: No userId is provided. Create a new user and associate the
                        // social login with
                        // it.
                        Log.debug(
                            "Social login not found and no userId provided. Creating a new user and associating it."
                        )

                        addUser().flatMap { newUser ->
                            insertSocialLogin(
                                    provider = provider,
                                    providerUserId = providerUserId,
                                    refreshToken = refreshToken,
                                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                                    userId = newUser.id,
                                    main = true,
                                )
                                .map { newUser }
                        }
                    }
                }
            }
        }
    }
}
