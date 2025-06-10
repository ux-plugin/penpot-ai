package com.plugin.features.user

import io.smallrye.mutiny.Uni

/**
 * Interface for the user service (business logic)
 */
interface IUserService {
    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     */
    fun getUser(userId: String): Uni<User>

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
