package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException

/**
 * Repository implementation for user configurations using Panache
 */
@ApplicationScoped
class UserRepository : PanacheRepository<UserEntity>, IUserRepository {

    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    override fun getUser(userId: String): Uni<User> {
        return withTransaction {
            find("userId", userId)
                .firstResult()
                .onItem().ifNull().failWith {
                    NotFoundException("User configuration not found for user: $userId")
                }
                .map { it?.toModel() }
        }
    }

    /**
     * Check if a user configuration exists
     * @param userId The ID of the user
     * @return True if the user configuration exists, false otherwise
     */
    override fun hasUser(userId: String): Uni<Boolean> {
        return withTransaction {
            find("userId", userId)
                .firstResult()
                .map { it != null }
        }
    }

    /**
     * Create or update user configuration
     * @param user The user configuration to create or update
     * @return The updated user configuration
     */
    override fun updateUser(user: User): Uni<User> {
        return withTransaction {
            find("userId", user.userId)
                .firstResult()
                .chain { existingUser ->
                    if (existingUser != null) {
                        existingUser.companionAppConnected = user.companionAppConnected
                        existingUser.companionAppPort = user.companionAppPort
                        persistAndFlush(existingUser)
                            .map { it.toModel() }
                    } else {
                        persistAndFlush(user.toEntity())
                            .map { it.toModel() }
                    }
                }
        }
    }

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    override fun createUser(user: User): Uni<User> {
        return withTransaction {
            find("userId", user.userId)
                .firstResult()
                .flatMap { existingUser ->
                    if (existingUser != null) {
                        Uni.createFrom().failure(IllegalArgumentException("User already exists"))
                    } else {
                        persistAndFlush(user.toEntity())
                            .map { it.toModel() }
                    }
                }
        }
    }
}
