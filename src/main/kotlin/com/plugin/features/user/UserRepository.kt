package com.plugin.features.user

import com.plugin.features.auth.core.SocialLoginEntity
import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import java.time.Instant
import org.eclipse.microprofile.config.inject.ConfigProperty

/** Repository implementation for user configurations using Panache */
@ApplicationScoped
class UserRepository(@param:ConfigProperty(name = "user.encryption-key-ttl-s") private val encryptionKeyTtl: Long) :
    PanacheRepository<UserEntity> {
    /**
     * Get user configuration by user ID
     *
     * @param userId The ID of the user
     * @return The user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    @WithSession
    fun getUser(userId: String): Uni<GetUserResponse> {
        return UserEntity.find("id", userId)
            .project(GetUserResponse::class.java)
            .firstResult()
            .onItem()
            .ifNull()
            .failWith(NotFoundException("User $userId not found"))
            .map { it }
    }

    /**
     * Update user configuration
     *
     * @param userId The id of the user
     * @param userUpdate The user configuration to update
     * @return The updated user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    @WithSession
    fun updateUser(userId: String, userUpdate: UpdateUserRequest): Uni<Unit> {
        return withTransaction {
            find("id", userId)
                .firstResult()
                .onItem()
                .ifNull()
                .failWith(NotFoundException("User $userId not found"))
                .chain { existingUser ->
                    val newUserEntity = existingUser as UserEntity

                    userUpdate.username?.let { newUserEntity.username = it }
                    userUpdate.name?.let { newUserEntity.name = it }
                    userUpdate.allowSavingCompletions?.let { newUserEntity.allowSavingCompletions = it }

                    persistAndFlush(newUserEntity)
                }
                .map { it }
                .replaceWith(Unit)
        }
    }

    @WithSession
    fun deleteUser(userId: String): Uni<Unit> {
        return delete("id", userId).map { it }.replaceWith(Unit)
    }

    @WithSession
    fun getSocialLogins(userId: String): Uni<GetSocialLoginsResponse> {
        return SocialLoginEntity.find("userId", userId).project(SocialLogin::class.java).list()
    }

    @WithSession
    fun getEncryptionKey(userId: String): Uni<EncryptionKeyResponse?> {
        return find("id", userId).firstResult().map { user ->
            if (user?.encryptionKey != null && user.encryptionKeyExpiresAt?.isAfter(Instant.now()) == true) {
                EncryptionKeyResponse(key = user.encryptionKey!!, expiresAt = user.encryptionKeyExpiresAt!!)
            } else {
                null
            }
        }
    }

    @WithSession
    fun saveEncryptionKey(userId: String, encryptionKey: String): Uni<EncryptionKeyResponse> {
        return withTransaction {
            find("id", userId).firstResult().flatMap { user ->
                if (user == null) {
                    Uni.createFrom().failure(NotFoundException("user does not exist"))
                } else {
                    user.encryptionKey = encryptionKey
                    val expiresAt = Instant.now().plusSeconds(encryptionKeyTtl)
                    user.encryptionKeyExpiresAt = expiresAt
                    persistAndFlush(user).map { EncryptionKeyResponse(encryptionKey, expiresAt) }
                }
            }
        }
    }

    @WithSession
    fun getPort(userId: String): Uni<PortState?> {
        return find("id", userId).firstResult().map { user -> user?.port?.let { PortState(it) } }
    }

    @WithSession
    fun savePort(userId: String, portState: PortState): Uni<Void> {
        return withTransaction {
            find("id", userId).firstResult().flatMap { user ->
                if (user == null) {
                    Uni.createFrom().failure(NotFoundException("user does not exist"))
                } else {
                    user.port = portState.port
                    persistAndFlush(user).replaceWithVoid()
                }
            }
        }
    }
}
