package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.replaceWithUnit
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import java.time.Instant

/**
 * Repository implementation for component completions using Panache
 */
@ApplicationScoped
class ComponentRepository(private val objectMapper: ObjectMapper) : PanacheRepository<ComponentCompletionEntity>,
    IComponentRepository {

    /**
     * Save a component completion.
     * @param userId The ID of the user.
     * @param prompt The prompt used to generate the component.
     * @param aiCompletion The generated component as a string.
     * @return A Uni representing the async save operation.
     */
    override fun saveCompletion(userId: String, prompt: String, aiCompletion: FrameNode): Uni<Unit> {
        return withTransaction {
            UserPermissions.find("id", userId)
                .firstResult()
                .onItem()
                .ifNull()
                .failWith {
                    NotFoundException("User not found: $userId")
                }
                .flatMap { permissions ->
                    if (permissions?.allowSavingCompletions == true) {
                        persistAndFlush(ComponentCompletionEntity().apply {
                            this.userId = userId
                            this.prompt = prompt
                            this.aiCompletion = objectMapper.writeValueAsString(aiCompletion)
                            this.createdAt = Instant.now()
                        })
                    } else {
                        Uni.createFrom()
                            .voidItem()
                    }
                }
                .replaceWithUnit()
        }
    }

    /**
     * Get all completions for a user
     * @param userId The ID of the user
     * @return List of component completions for the user
     */
    @WithSession
    override fun getCompletions(userId: String): Uni<List<ComponentCompletion>> {
        return ComponentCompletionEntity.find("userId", userId)
            .project(ComponentCompletion::class.java)
            .list()
    }

    /**
     * Get a specific completion
     * @param userId The ID of the user
     * @param completionId The ID of the completion
     * @return The component completion
     * @throws NotFoundException if the completion is not found
     */
    @WithSession
    override fun getCompletion(userId: String, completionId: String): Uni<ComponentCompletion> {
        return ComponentCompletionEntity.find("userId = ?1 and id = ?2", userId, completionId)
            .project(ComponentCompletion::class.java)
            .firstResult()
            .onItem()
            .ifNull()
            .failWith {
                NotFoundException("Completion not found for user: $userId and completion: $completionId")
            }
            .map { it }
    }

    /**
     * Delete all completions from the database
     * Primarily used for testing purposes
     */
    @WithSession
    override fun deleteAllCompletions(): Uni<Long> {
        return deleteAll()
    }
}
