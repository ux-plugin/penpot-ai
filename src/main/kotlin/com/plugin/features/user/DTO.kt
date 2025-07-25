package com.plugin.features.user

data class GetUserResponse(
    val id: String,
    val name: String,
    val username: String,
    val allowSavingCompletions: Boolean
)

data class UpdateUserRequest(
    val name: String?,
    val username: String?,
    val allowSavingCompletions: Boolean?
)
