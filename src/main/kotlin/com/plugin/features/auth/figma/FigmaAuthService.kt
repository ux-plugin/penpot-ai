package com.plugin.features.auth.figma

import com.plugin.config.JwtService
import com.plugin.features.auth.core.*
import org.springframework.beans.factory.annotation.Value
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
    @Value("\${auth.figma.client-id}") private val clientId: String,
    @Value("\${auth.figma.client-secret}") private val clientSecret: String,
    @Value("\${auth.figma.login-redirect-uri}") private val loginRedirectUri: String,
    @Value("\${auth.figma.connect-redirect-uri}") private val connectRedirectUri: String,
    @Value("\${auth.figma.connect.redis-key-prefix}") private val resultKeyPrefix: String,
    @Value("\${auth.figma.user-id.result-key-prefix}") private val userIdPrefix: String,
    @Value("\${auth.figma.login.random-key.max-retries}") private val randomKeyGenerationMaxRetries: Int,
    @Value("\${auth.figma.login.timeout-sec}") private val loginTimeout: Long,
    @Value("\${auth.figma.rest-client.access-token.redis-key-prefix}") private val restClientAccessTokenKeyPrefix: String,
    @Value("\${auth.figma.read-token.redis-key-prefix}") private val readTokenPrefix: String,
    @Value("\${auth.figma.write-token.redis-key-prefix}") private val writeTokenPrefix: String,
) {

    suspend fun login(): OAuthInitResponse {
        val readToken = redisRepository.generateUniqueKey(
            readTokenPrefix,
            randomKeyGenerationMaxRetries,
            "",
            2 * loginTimeout,
        )
        val writeToken = redisRepository.generateUniqueKey(
            writeTokenPrefix,
            randomKeyGenerationMaxRetries,
            readToken,
            2 * loginTimeout,
        )

        val readTokenJwt = jwtService.createToken(readToken, "GUEST", loginTimeout)

        val redirectUri = generateOAuthUrl(
            writeToken,
            scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ),
            redirectUri = loginRedirectUri,
        )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    fun generateOAuthUrl(
        state: String,
        scopes: List<FigmaAccessScope>,
        redirectUri: String,
    ): String {
        return "https://www.figma.com/oauth" +
                "?client_id=${URLEncoder.encode(clientId, "UTF-8")}" +
                "&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}" +
                "&scope=${scopes.joinToString("%2C") { URLEncoder.encode(it.value, "UTF-8") }}" +
                "&state=${URLEncoder.encode(state, "UTF-8")}" +
                "&response_type=code"
    }

    suspend fun exchangeCodeForToken(code: String, redirectUri: String): FigmaOAuthTokenResponse {
        return figmaAuthClient.exchangeToken(
            clientId = clientId,
            clientSecret = clientSecret,
            code = code,
            redirectUri = redirectUri,
        )
    }

    suspend fun authenticateUser(state: String, code: String) {
        val redisKey = writeTokenPrefix + state
        val readToken = redisRepository.getValue(redisKey) 
            ?: throw NotFoundException("Invalid state")

        val figmaOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = loginRedirectUri)
        val userInfo = figmaApiClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}")

        val refreshTokenExpiresAt = Instant.now().plusSeconds(figmaOAuthTokenResponse.expiresIn)

        val user = authRepository.associateUserWithSocialProvider(
            SocialProvider.FIGMA,
            userInfo.id,
            figmaOAuthTokenResponse.refreshToken,
            refreshTokenExpiresAt,
        )

        val accessTokenKey = restClientAccessTokenKeyPrefix + user.id
        redisRepository.setValueWithExpiration(
            accessTokenKey,
            figmaOAuthTokenResponse.accessToken,
            figmaOAuthTokenResponse.expiresIn,
        )

        val appTokens = authRepository.createTokensForUser(user.id, role = user.role)

        val queueName = restClientAccessTokenKeyPrefix + readToken
        redisRepository.pushAccessToken(queueName, appTokens.accessToken)
    }

    suspend fun readAccessToken(readToken: String): Pair<String, String>? {
        val queueName = restClientAccessTokenKeyPrefix + readToken
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(loginTimeout),
        )
    }

    suspend fun connectInitiate(userId: String): ConnectInitResponse {
        val readToken = redisRepository.generateUniqueKey(
            readTokenPrefix,
            randomKeyGenerationMaxRetries,
            "",
            2 * loginTimeout,
        )
        val writeToken = redisRepository.generateUniqueKey(
            writeTokenPrefix,
            randomKeyGenerationMaxRetries,
            readToken,
            2 * loginTimeout,
        )
        redisRepository.setValueWithExpiration(
            userIdPrefix + writeToken,
            userId,
            2 * loginTimeout,
        )

        val redirectUri = generateOAuthUrl(
            writeToken,
            scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ),
            redirectUri = connectRedirectUri,
        )

        return ConnectInitResponse(readToken, redirectUri)
    }

    suspend fun connectSocialProfile(code: String, state: String) {
        val userId = redisRepository.getValue(userIdPrefix + state) 
            ?: throw NotFoundException("Invalid state")

        try {
            val figmaOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = connectRedirectUri)
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

            val queueName = resultKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.SUCCESS.value)
        } catch (e: Exception) {
            val queueName = resultKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.FAILURE.value)
            throw e
        }
    }

    suspend fun getConnectResult(userId: String): Pair<String, String>? {
        val queueName = resultKeyPrefix + userId
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(loginTimeout),
        )
    }
}
