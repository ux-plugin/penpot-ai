package com.plugin.api.features.auth.core

/** Data Transfer Objects for authentication */

/** OAuth initialization response — opaque read-token for polling, plus the redirect URL. */
data class OAuthInitResponse(val readToken: String, val loginUrl: String)

data class ConnectInitResponse(val readToken: String, val loginUrl: String)

data class ConnectResultRequest(val readToken: String)

data class ConnectSocialProviderResponse(val result: String)

/** Read token response */
data class AccessTokenResponse(val accessToken: String)

/** Error response for authentication failures */
data class AuthErrorResponse(val message: String = "Invalid username or password.")
