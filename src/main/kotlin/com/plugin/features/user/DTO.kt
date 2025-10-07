package com.plugin.features.user

data class GetUserResponse(
    val id: String,
    val name: String,
    val username: String?,
    val allowSavingCompletions: Boolean,
)

data class UpdateUserRequest(
    val name: String?,
    val username: String?,
    val allowSavingCompletions: Boolean?,
)

data class SocialLogin(val provider: String, val id: String, val providerUserId: String)

typealias GetSocialLoginsResponse = List<SocialLogin>

data class EncryptionKeyResponse(val key: String, val expiresAt: java.time.Instant)

data class PortState(val port: Int?)
