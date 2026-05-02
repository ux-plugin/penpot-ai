package com.plugin.features.auth.figma

import com.plugin.config.properties.AuthProperties
import com.plugin.features.auth.core.AccountAlreadyLinkedException
import com.plugin.features.auth.core.AuthRepository
import com.plugin.features.auth.core.ConnectInitResponse
import com.plugin.features.auth.core.ConnectSocialProviderResult
import com.plugin.features.auth.core.NotFoundException
import com.plugin.features.auth.core.RedisRepository
import com.plugin.features.auth.core.SocialProvider
import org.springframework.stereotype.Service
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant

@Service
class FigmaAuthService(
    private val figmaApiClient: FigmaApiClient,
    private val figmaAuthClient: FigmaAuthClient,
    private val authRepository: AuthRepository,
    private val redisRepository: RedisRepository,
    authProperties: AuthProperties,
) {
    private val figmaConfig = authProperties.figma

    private fun generateOAuthUrl(state: String, scopes: List<FigmaAccessScope>, redirectUri: String): String = buildString {
        append(figmaConfig.authUrl)
        append("?client_id=${URLEncoder.encode(figmaConfig.clientId, "UTF-8")}")
        append("&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}")
        append("&scope=${scopes.joinToString("%2C") { URLEncoder.encode(it.value, "UTF-8") }}")
        append("&state=${URLEncoder.encode(state, "UTF-8")}")
        append("&response_type=code")
    }

    private suspend fun exchangeCodeForToken(code: String, redirectUri: String): FigmaOAuthTokenResponse = figmaAuthClient.exchangeToken(
        clientId = figmaConfig.clientId,
        clientSecret = figmaConfig.clientSecret,
        code = code,
        redirectUri = redirectUri,
    )

    suspend fun connectInitiate(userId: String): ConnectInitResponse {
        val readToken =
            redisRepository.generateUniqueKey(
                figmaConfig.readToken.redisKeyPrefix,
                figmaConfig.flow.randomKey.maxRetries,
                "",
                2 * figmaConfig.flow.timeoutSec,
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                figmaConfig.writeToken.redisKeyPrefix,
                figmaConfig.flow.randomKey.maxRetries,
                readToken,
                2 * figmaConfig.flow.timeoutSec,
            )
        redisRepository.setValueWithExpiration(
            figmaConfig.userId.resultKeyPrefix + writeToken,
            userId,
            2 * figmaConfig.flow.timeoutSec,
        )

        val redirectUri =
            generateOAuthUrl(
                writeToken,
                scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ),
                redirectUri = figmaConfig.connectRedirectUri,
            )

        return ConnectInitResponse(readToken, redirectUri)
    }

    suspend fun connectSocialProfile(code: String, state: String) {
        val userId =
            redisRepository.getValue(figmaConfig.userId.resultKeyPrefix + state)
                ?: throw NotFoundException("Invalid state")

        try {
            val figmaOAuthTokenResponse =
                exchangeCodeForToken(code = code, redirectUri = figmaConfig.connectRedirectUri)
            val userInfo = figmaApiClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}")
            val refreshTokenExpiresAt = Instant.now().plusSeconds(figmaOAuthTokenResponse.expiresIn)

            val socialProfile = authRepository.getSocialLogin(userInfo.id, SocialProvider.FIGMA)
            if (socialProfile != null && socialProfile.userId != userId) {
                throw AccountAlreadyLinkedException("Account already linked.")
            }
            if (socialProfile == null) {
                authRepository.insertSocialLogin(
                    provider = SocialProvider.FIGMA,
                    userId = userId,
                    providerUserId = userInfo.id,
                    refreshToken = figmaOAuthTokenResponse.refreshToken,
                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                )
            }

            val queueName = figmaConfig.connect.redisKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.SUCCESS.value)
        } catch (e: Exception) {
            val queueName = figmaConfig.connect.redisKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.FAILURE.value)
            throw e
        }
    }

    suspend fun getConnectResult(userId: String): Pair<String, String>? {
        val queueName = figmaConfig.connect.redisKeyPrefix + userId
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(figmaConfig.flow.timeoutSec),
        )
    }
}
