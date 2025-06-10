package com.plugin.features.completions

/**
 * Mapper functions to convert between database models and domain models
 */

/**
 * Convert ComponentCompletionEntity to ComponentCompletion
 */
fun ComponentCompletionEntity.toModel(): ComponentCompletion =
    ComponentCompletion(
        userId = userId,
        completionId = completionId,
        prompt = prompt,
        aiCompletion = aiCompletion,
        createdAt = createdAt
    )

/**
 * Convert ComponentCompletion to ComponentCompletionEntity
 */
fun ComponentCompletion.toEntity(): ComponentCompletionEntity =
    ComponentCompletionEntity().apply {
        userId = this@toEntity.userId
        completionId = this@toEntity.completionId
        prompt = this@toEntity.prompt
        aiCompletion = this@toEntity.aiCompletion
        createdAt = this@toEntity.createdAt // Assuming this is already Instant
    }

/**
 * Extension function to convert a list of ComponentCompletionEntity to a list of ComponentCompletion
 */
fun List<ComponentCompletionEntity>.toModels(): List<ComponentCompletion> =
    map { it.toModel() }
