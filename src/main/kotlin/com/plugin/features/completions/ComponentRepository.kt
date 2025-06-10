package com.plugin.features.completions

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import java.util.*

/**
 * Repository implementation for component completions using Panache
 */
@ApplicationScoped
class ComponentRepository : PanacheRepository<ComponentCompletionEntity>, IComponentRepository {

    /**
     * Save a component completion
     * @param userId The ID of the user
     * @param prompt The prompt used to generate the component
     * @param aiCompletion The generated component as a string
     * @return The saved component completion
     */
    override fun saveCompletion(userId: String, prompt: String, aiCompletion: String): Uni<ComponentCompletion> {
        val completion = ComponentCompletion().apply {
            this.userId = userId
            this.completionId = UUID.randomUUID().toString()
            this.prompt = prompt
            this.aiCompletion = aiCompletion
        }

        return persistAndFlush(completion.toEntity())
            .map { it.toModel() }
    }

    /**
     * Get all completions for a user
     * @param userId The ID of the user
     * @return List of component completions for the user
     */
    override fun getCompletions(userId: String): Uni<List<ComponentCompletion>> {
        return ComponentCompletionEntity.findByUserId(userId)
            .map { it.toModels() }
    }

    /**
     * Get a specific completion
     * @param userId The ID of the user
     * @param completionId The ID of the completion
     * @return The component completion
     * @throws NotFoundException if the completion is not found
     */
    override fun getCompletion(userId: String, completionId: String): Uni<ComponentCompletion> {
        return find("userId = ?1 and completionId = ?2", userId, completionId)
            .firstResult()
            .onItem().ifNull().failWith {
                NotFoundException("Completion not found for user: $userId and completion: $completionId")
            }
            .map { it?.toModel() }
    }

    /**
     * Delete all completions from the database
     * Primarily used for testing purposes
     */
    override fun deleteAllCompletions(): Uni<Long> {
        return deleteAll()
    }
}
