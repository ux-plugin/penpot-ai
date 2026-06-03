package com.plugin.api.features.user

import com.plugin.api.features.auth.core.SocialProvider

data class GetUserResponse(
    val id: String,
    val name: String,
    val username: String?,
    val role: UserRole,
    val allowSavingCompletions: Boolean,
    val port: Int?,
)

data class UpdateUserRequest(val name: String?, val username: String?, val allowSavingCompletions: Boolean?)

data class SocialLogin(val id: String, val provider: SocialProvider)

data class GetSocialLoginsResponse(val logins: List<SocialLogin>)

data class EncryptionKeyResponse(val key: String, val expiresAt: java.time.Instant)

data class PortState(val port: Int)
