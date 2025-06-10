package com.plugin.features.user

/**
 * Mapper functions to convert between database models and domain models
 */

/**
 * Convert User domain model to UserEntity (database model)
 */
fun User.toEntity(): UserEntity {
    return UserEntity().apply {
        userId = this@toEntity.userId
        companionAppConnected = this@toEntity.companionAppConnected
        companionAppPort = this@toEntity.companionAppPort
    }
}

/**
 * Convert UserEntity (database model) to User domain model
 */
fun UserEntity.toModel(): User = User(
    userId = userId,
    companionAppConnected = companionAppConnected,
    companionAppPort = companionAppPort
)