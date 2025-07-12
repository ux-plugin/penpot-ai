package com.plugin.features.completions

import io.smallrye.mutiny.Uni

/**
 * Service interface for component-related operations.
 */
interface IComponentService {

    fun createComponentLangChain(prompt: String, userId: String): Uni<FrameNode>

    /**
     * Save a completion
     * @param userId The ID of the user
     * @param prompt The prompt used to generate the component
     * @param aiCompletion The generated component
     * @return A Uni that emits the saved ComponentCompletion
     */
    fun saveCompletion(userId: String, prompt: String, aiCompletion: FrameNode): Uni<Unit>


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
