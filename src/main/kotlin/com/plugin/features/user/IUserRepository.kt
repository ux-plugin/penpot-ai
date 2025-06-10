package com.plugin.features.user

import io.smallrye.mutiny.Uni
import jakarta.ws.rs.NotFoundException

/**
 * Interface for the user repository (database access)
 */
interface IUserRepository {
    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    fun getUser(userId: String): Uni<User>

    /**
     * Check if a user configuration exists
     * @param userId The ID of the user
     * @return True if the user configuration exists, false otherwise
     */
    fun hasUser(userId: String): Uni<Boolean>

    /**
     * Create or update user configuration
     * @param user The user configuration to create or update
     * @return The updated user configuration
     */
    fun updateUser(user: User): Uni<User>

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    fun createUser(user: User): Uni<User>
}
