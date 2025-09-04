package com.plugin.features.auth.core

import java.time.Instant

/** Data Transfer Objects for authentication */

/** Request for token refresh */
data class RefreshTokenRequest(val refreshToken: String, val userId: String)

data class RefreshTokenInfo(val refreshToken: String, val expiresAt: Instant)

data class RefreshAccessTokenResponse(val accessToken: String)

data class FigmaPluginGetRefreshTokenResponse(val refreshToken: String, val refreshTokenExpiresAt: Instant)

data class FigmaPluginRefreshAccessTokenRequest(val refreshToken: String, val userId: String)

/** OAuth initialization response */
data class OAuthInitResponse(val readTokenJwt: String, val loginUrl: String)

data class ConnectInitResponse(val readToken: String, val loginUrl: String)

data class ConnectResultRequest(val readToken: String)

data class ConnectSocialProviderResponse(val result: String)

/** Read token response */
data class AccessTokenResponse(val accessToken: String)

/** Error response for authentication failures */
data class AuthErrorResponse(val message: String = "Invalid username or password.")
