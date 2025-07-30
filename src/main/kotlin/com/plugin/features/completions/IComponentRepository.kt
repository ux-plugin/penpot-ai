package com.plugin.features.completions

import io.smallrye.mutiny.Uni

/**
 * Interface for the component repository
 */
interface IComponentRepository {

    /**
     * Save a component completion
     * @param userId The ID of the user
     * @param prompt The prompt used to generate the component
     * @param aiCompletion The generated component as a string
     * @return The saved component completion
     */
    fun saveCompletion(userId: String, prompt: String, aiCompletion: FrameNode): Uni<Unit>

    /**
     * Get all completions for a user
     * @param userId The ID of the user
     * @return List of component completions for the user
     */
    fun getCompletions(userId: String): Uni<List<ComponentCompletion>>

    /**
     * Get a specific completion
     * @param userId The ID of the user
     * @param completionId The ID of the completion
     * @return The component completion
     */
    fun getCompletion(userId: String, completionId: String): Uni<ComponentCompletion?>

    /**
     * Delete all completions from the database
     * Primarily used for testing purposes
     */
    fun deleteAllCompletions(): Uni<Long>
}
