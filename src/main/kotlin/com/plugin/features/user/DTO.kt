package com.plugin.features.user

data class CreateUserRequest(
    val name: String,
    val username: String,
    val password: String
)

data class CreateUserResponse(
    val id: String,
)

data class GetUserResponse(
    val id: String,
    val name: String,
    val username: String,
    val companionAppConnected: Boolean,
    val companionAppPort: Int,
    val allowSavingCompletions: Boolean
)

data class UpdateUserRequest(
    val name: String?,
    val username: String?,
    val password: String?,
    val companionAppConnected: Boolean?,
    val companionAppPort: Int?,
    val allowSavingCompletions: Boolean?
)
