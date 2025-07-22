package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import org.eclipse.microprofile.config.inject.ConfigProperty

/**
 * Repository implementation for user configurations using Panache
 */
@ApplicationScoped
class UserRepository(
    @ConfigProperty(name = "user.email-verification.code.max-generation-attempts", defaultValue = "5")
    private val maxEmailVerificationCodeGenerationAttempts: Int,
) : PanacheRepository<UserEntity>, IUserRepository {
    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    @WithSession
    override fun getUser(userId: String): Uni<GetUserResponse> {
        return UserEntity.find("id", userId)
            .project(GetUserResponse::class.java)
            .firstResult()
            .onItem().ifNull().failWith(NotFoundException("User $userId not found"))
            .map { it }
    }

    /**
     * Update user configuration
     * @param userId The id of the user
     * @param userUpdate The user configuration to update
     * @return The updated user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    override fun updateUser(userId: String, userUpdate: UpdateUserRequest): Uni<Unit> {
        return withTransaction {
            find("id", userId)
                .firstResult()
                .onItem().ifNull().failWith(NotFoundException("User $userId not found"))
                .chain { existingUser ->
                    val newUserEntity = existingUser as UserEntity

                    userUpdate.username?.let { newUserEntity.username = it }
                    userUpdate.name?.let { newUserEntity.name = it }
                    userUpdate.companionAppConnected?.let { newUserEntity.companionAppConnected = it }
                    userUpdate.companionAppPort?.let { newUserEntity.companionAppPort = it }
                    userUpdate.allowSavingCompletions?.let { newUserEntity.allowSavingCompletions = it }

                    persistAndFlush(newUserEntity)
                }
                .map { it }.replaceWith(Unit)
        }
    }
}
