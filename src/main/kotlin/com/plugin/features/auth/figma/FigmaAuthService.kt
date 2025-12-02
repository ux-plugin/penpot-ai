package com.plugin.features.auth.figma

import com.plugin.config.JwtService
import com.plugin.config.properties.AuthProperties
import com.plugin.features.auth.core.AccountAlreadyLinkedException
import com.plugin.features.auth.core.AuthRepository
import com.plugin.features.auth.core.ConnectInitResponse
import com.plugin.features.auth.core.ConnectSocialProviderResult
import com.plugin.features.auth.core.NotFoundException
import com.plugin.features.auth.core.OAuthInitResponse
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
    private val jwtService: JwtService,
    authProperties: AuthProperties,
) {
    private val figmaConfig = authProperties.figma

    suspend fun login(): OAuthInitResponse {
        val readToken =
            redisRepository.generateUniqueKey(
                figmaConfig.readToken.redisKeyPrefix,
                figmaConfig.login.randomKey.maxRetries,
                "",
                2 * figmaConfig.login.timeoutSec,
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                figmaConfig.writeToken.redisKeyPrefix,
                figmaConfig.login.randomKey.maxRetries,
                readToken,
                2 * figmaConfig.login.timeoutSec,
            )

        val readTokenJwt = jwtService.createToken(readToken, "GUEST", figmaConfig.login.timeoutSec)

        val redirectUri =
            generateOAuthUrl(
                writeToken,
                scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ),
                redirectUri = figmaConfig.loginRedirectUri,
            )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    fun generateOAuthUrl(state: String, scopes: List<FigmaAccessScope>, redirectUri: String): String = buildString {
        append(figmaConfig.authUrl)
        append("?client_id=${URLEncoder.encode(figmaConfig.clientId, "UTF-8")}")
        append("&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}")
        append("&scope=${scopes.joinToString("%2C") { URLEncoder.encode(it.value, "UTF-8") }}")
        append("&state=${URLEncoder.encode(state, "UTF-8")}")
        append("&response_type=code")
    }

    suspend fun exchangeCodeForToken(code: String, redirectUri: String): FigmaOAuthTokenResponse = figmaAuthClient.exchangeToken(
        clientId = figmaConfig.clientId,
        clientSecret = figmaConfig.clientSecret,
        code = code,
        redirectUri = redirectUri,
    )

    suspend fun authenticateUser(state: String, code: String) {
        val redisKey = figmaConfig.writeToken.redisKeyPrefix + state
        val readToken = redisRepository.getValue(redisKey) ?: throw NotFoundException("Invalid state")

        val figmaOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = figmaConfig.loginRedirectUri)
        val userInfo = figmaApiClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}")

        val refreshTokenExpiresAt = Instant.now().plusSeconds(figmaOAuthTokenResponse.expiresIn)

        val user =
            authRepository.associateUserWithSocialProvider(
                SocialProvider.FIGMA,
                userInfo.id,
                figmaOAuthTokenResponse.refreshToken,
                refreshTokenExpiresAt,
            )

        val accessTokenKey = figmaConfig.restClient.accessToken.redisKeyPrefix + user.id
        redisRepository.setValueWithExpiration(
            accessTokenKey,
            figmaOAuthTokenResponse.accessToken,
            figmaOAuthTokenResponse.expiresIn,
        )

        val appTokens = authRepository.createTokensForUser(user.id, role = user.role)

        val queueName = figmaConfig.restClient.accessToken.redisKeyPrefix + readToken
        redisRepository.pushAccessToken(queueName, appTokens.accessToken)
    }

    suspend fun readAccessToken(readToken: String): Pair<String, String>? {
        val queueName = figmaConfig.restClient.accessToken.redisKeyPrefix + readToken
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(figmaConfig.login.timeoutSec),
        )
    }

    suspend fun connectInitiate(userId: String): ConnectInitResponse {
        val readToken =
            redisRepository.generateUniqueKey(
                figmaConfig.readToken.redisKeyPrefix,
                figmaConfig.login.randomKey.maxRetries,
                "",
                2 * figmaConfig.login.timeoutSec,
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                figmaConfig.writeToken.redisKeyPrefix,
                figmaConfig.login.randomKey.maxRetries,
                readToken,
                2 * figmaConfig.login.timeoutSec,
            )
        redisRepository.setValueWithExpiration(
            figmaConfig.userId.resultKeyPrefix + writeToken,
            userId,
            2 * figmaConfig.login.timeoutSec,
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
            timeout = Duration.ofSeconds(figmaConfig.login.timeoutSec),
        )
    }
}
