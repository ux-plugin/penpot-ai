package com.plugin.features.completions

import io.smallrye.mutiny.Uni

/**
 * Service interface for component-related operations.
 */
interface IComponentService {
    /**
     * Get a component based on a prompt
     * @param prompt The prompt to generate the component from
     * @param userId The ID of the user
     * @return A Uni that emits the generated FrameNode
     */
    fun getComponent(prompt: String, userId: String): Uni<FrameNode>

    /**
     * Save a completion
     * @param userId The ID of the user
     * @param prompt The prompt used to generate the component
     * @param aiCompletion The generated component as a string
     * @return A Uni that emits the saved ComponentCompletion
     */
    fun saveCompletion(userId: String, prompt: String, aiCompletion: String): Uni<ComponentCompletion>


    /**
     * Get all completions for a user
     * @param userId The ID of the user
     * @return A Uni that emits a list of ComponentCompletions
     */
    fun getCompletions(userId: String): Uni<List<ComponentCompletion>>

    /**
     * Get a specific completion
     * @param userId The ID of the user
     * @param completionId The ID of the completion
     * @return A Uni that emits the ComponentCompletion
     */
    fun getCompletion(userId: String, completionId: String): Uni<ComponentCompletion>
}
