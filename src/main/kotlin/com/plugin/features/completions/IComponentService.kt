package com.plugin.features.completions

/**
 * Service interface for component-related operations.
 */
interface IComponentService {

    suspend fun createComponentLangChain(prompt: String, userId: String): FrameNode

    /**
     * Save a completion
     * @param userId The ID of the user
     * @param prompt The prompt used to generate the component
     * @param aiCompletion The generated component
     */
    suspend fun saveCompletion(userId: String, prompt: String, aiCompletion: FrameNode)


    /**
     * Get all completions for a user
     * @param userId The ID of the user
     * @return A list of ComponentCompletions
     */
    suspend fun getCompletions(userId: String): List<ComponentCompletion>

    /**
     * Get a specific completion
     * @param userId The ID of the user
     * @param completionId The ID of the completion
     * @return The ComponentCompletion
     */
    suspend fun getCompletion(userId: String, completionId: String): ComponentCompletion?
}
