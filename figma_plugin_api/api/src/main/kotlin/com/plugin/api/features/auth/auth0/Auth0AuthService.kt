package com.plugin.api.features.auth.auth0

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.api.config.properties.Auth0Properties
import com.plugin.api.features.auth.core.NotFoundException
import com.plugin.api.features.auth.core.OAuthInitResponse
import com.plugin.api.features.auth.core.RedisRepository
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.stereotype.Service
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant

@Service
@ConditionalOnProperty(prefix = "auth0.oauth", name = ["client-id"])
class Auth0AuthService(
    private val auth0AuthClient: Auth0AuthClient,
    private val redisRepository: RedisRepository,
    private val auth0Properties: Auth0Properties,
    private val objectMapper: ObjectMapper,
) {
    suspend fun login(): OAuthInitResponse {
        val oauth = auth0Properties.oauth
        val readToken =
            redisRepository.generateUniqueKey(
                oauth.readToken.redisKeyPrefix,
                oauth.login.randomKey.maxRetries,
                "",
                2 * oauth.login.timeoutSec,
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                oauth.writeToken.redisKeyPrefix,
                oauth.login.randomKey.maxRetries,
                readToken,
                2 * oauth.login.timeoutSec,
            )
        val authorizeUrl = generateAuthorizeUrl(state = writeToken, redirectUri = requireNotNull(oauth.loginRedirectUri))
        return OAuthInitResponse(readToken, authorizeUrl)
    }

    private fun generateAuthorizeUrl(state: String, redirectUri: String): String {
        val oauth = auth0Properties.oauth
        val baseUrl = requireNotNull(auth0Properties.resolvedAuthorizeUrl()) { "auth0.issuer is not configured" }
        val audience = requireNotNull(auth0Properties.audience) { "auth0.audience is not configured" }
        return buildString {
            append(baseUrl)
            append("?response_type=code")
            append("&client_id=${URLEncoder.encode(requireNotNull(oauth.clientId), "UTF-8")}")
            append("&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}")
            append("&scope=${URLEncoder.encode(oauth.scope, "UTF-8")}")
            append("&audience=${URLEncoder.encode(audience, "UTF-8")}")
            append("&state=${URLEncoder.encode(state, "UTF-8")}")
        }
    }

    suspend fun authenticateUser(state: String, code: String) {
        val oauth = auth0Properties.oauth
        val redisKey = oauth.writeToken.redisKeyPrefix + state
        val readToken = redisRepository.getValue(redisKey) ?: throw NotFoundException("Invalid state")

        val tokenResponse = auth0AuthClient.exchangeCodeForToken(code = code, redirectUri = requireNotNull(oauth.loginRedirectUri))
        val refreshToken =
            tokenResponse.refreshToken
                ?: throw IllegalStateException(
                    "Auth0 did not return a refresh token; verify offline_access scope and refresh-token rotation are enabled",
                )

        val tokens =
            Auth0PluginTokensResponse(
                accessToken = tokenResponse.accessToken,
                refreshToken = refreshToken,
                refreshTokenExpiresAt = Instant.now().plusSeconds(oauth.refreshTokenLifetimeSec),
            )

        val queueName = oauth.tokens.redisKeyPrefix + readToken
        redisRepository.pushAccessToken(queueName, objectMapper.writeValueAsString(tokens))
    }

    suspend fun readTokens(readToken: String): Auth0PluginTokensResponse? {
        val oauth = auth0Properties.oauth
        val queueName = oauth.tokens.redisKeyPrefix + readToken
        val polled =
            redisRepository.readAccessToken(
                readToken = queueName,
                timeout = Duration.ofSeconds(oauth.login.timeoutSec),
            ) ?: return null
        return objectMapper.readValue(polled.second, Auth0PluginTokensResponse::class.java)
    }

    suspend fun refreshTokens(refreshToken: String): Auth0PluginTokensResponse {
        val oauth = auth0Properties.oauth
        val tokenResponse = auth0AuthClient.refreshToken(refreshToken)
        val rotated = tokenResponse.refreshToken ?: refreshToken
        return Auth0PluginTokensResponse(
            accessToken = tokenResponse.accessToken,
            refreshToken = rotated,
            refreshTokenExpiresAt = Instant.now().plusSeconds(oauth.refreshTokenLifetimeSec),
        )
    }
}
