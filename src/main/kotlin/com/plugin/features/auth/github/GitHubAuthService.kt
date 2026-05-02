package com.plugin.features.auth.github

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
class GitHubAuthService(
    private val githubApiClient: GitHubApiClient,
    private val githubAuthClient: GitHubAuthClient,
    private val authRepository: AuthRepository,
    private val redisRepository: RedisRepository,
    private val authProperties: AuthProperties,
) {
    private fun generateConnectUrl(state: String, scopes: List<GitHubAccessScope>, redirectUri: String): String = buildString {
        append("https://github.com/login/oauth/authorize")
        append("?client_id=${URLEncoder.encode(authProperties.github.clientId, "UTF-8")}")
        append("&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}")
        append("&scope=${scopes.joinToString("%20") { URLEncoder.encode(it.value, "UTF-8") }}")
        append("&state=${URLEncoder.encode(state, "UTF-8")}")
        append("&allow_signup=true")
    }

    private suspend fun exchangeCodeForToken(code: String, redirectUri: String): GitHubOAuthTokenResponse = githubAuthClient.exchangeToken(
        clientId = authProperties.github.clientId,
        clientSecret = authProperties.github.clientSecret,
        code = code,
        redirectUri = redirectUri,
    )

    suspend fun connectInitiate(userId: String): ConnectInitResponse {
        val readToken =
            redisRepository.generateUniqueKey(
                authProperties.github.readToken.redisKeyPrefix,
                authProperties.github.flow.randomKey.maxRetries,
                "",
                2 * authProperties.github.flow.timeoutSec,
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                authProperties.github.writeToken.redisKeyPrefix,
                authProperties.github.flow.randomKey.maxRetries,
                readToken,
                2 * authProperties.github.flow.timeoutSec,
            )
        redisRepository.setValueWithExpiration(
            authProperties.github.userId.resultKeyPrefix + writeToken,
            userId,
            2 * authProperties.github.flow.timeoutSec,
        )

        val redirectUri =
            generateConnectUrl(
                writeToken,
                scopes = listOf(GitHubAccessScope.USER, GitHubAccessScope.USER_EMAIL),
                redirectUri = authProperties.github.connectRedirectUri,
            )

        return ConnectInitResponse(readToken, redirectUri)
    }

    suspend fun connectSocialProfile(code: String, state: String) {
        val userId =
            redisRepository.getValue(authProperties.github.userId.resultKeyPrefix + state)
                ?: throw NotFoundException("Invalid state")

        try {
            val githubOAuthTokenResponse =
                exchangeCodeForToken(code = code, redirectUri = authProperties.github.connectRedirectUri)
            val userInfo = githubApiClient.getUser("Bearer ${githubOAuthTokenResponse.accessToken}")
            val refreshTokenExpiresAt = Instant.now().plusSeconds(githubOAuthTokenResponse.refreshTokenExpiresIn)

            val socialProfile = authRepository.getSocialLogin(userInfo.id.toString(), SocialProvider.GITHUB)
            if (socialProfile != null && socialProfile.userId != userId) {
                throw AccountAlreadyLinkedException("Account already linked.")
            }
            if (socialProfile == null) {
                authRepository.insertSocialLogin(
                    provider = SocialProvider.GITHUB,
                    userId = userId,
                    providerUserId = userInfo.id.toString(),
                    refreshToken = githubOAuthTokenResponse.refreshToken,
                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                )
            }

            val queueName = authProperties.github.connect.resultKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.SUCCESS.value)
        } catch (e: Exception) {
            val queueName = authProperties.github.connect.resultKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.FAILURE.value)
            throw e
        }
    }

    suspend fun getConnectResult(userId: String): Pair<String, String>? {
        val queueName = authProperties.github.connect.resultKeyPrefix + userId
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(authProperties.github.flow.timeoutSec),
        )
    }
}
