package com.plugin.features.auth.github

import com.plugin.config.JwtService
import com.plugin.features.auth.core.*
import org.springframework.beans.factory.annotation.Value
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
    private val jwtService: JwtService,
    @Value("\${auth.github.client-id}") private val clientId: String,
    @Value("\${auth.github.client-secret}") private val clientSecret: String,
    @Value("\${auth.github.login-redirect-uri}") private val loginRedirectUri: String,
    @Value("\${auth.github.connect-redirect-uri}") private val connectRedirectUri: String,
    @Value("\${auth.github.connect.result-key-prefix}") private val resultKeyPrefix: String,
    @Value("\${auth.github.login.random-key.max-retries}") private val randomKeyGenerationMaxRetries: Int,
    @Value("\${auth.github.login.timeout-sec}") private val loginTimeout: Long,
    @Value("\${auth.github.rest-client.access-token.redis-key-prefix}") private val restClientAccessTokenKeyPrefix: String,
    @Value("\${auth.github.read-token.redis-key-prefix}") private val readTokenPrefix: String,
    @Value("\${auth.github.user-id.redis-key-prefix}") private val userIdPrefix: String,
    @Value("\${auth.github.write-token.redis-key-prefix}") private val writeTokenPrefix: String,
    @Value("\${auth.access-token-ttl-s}") private val accessTokenTtl: Long,
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

        val redirectUri = generateConnectUrl(
            writeToken,
            scopes = listOf(GitHubAccessScope.USER, GitHubAccessScope.USER_EMAIL),
            redirectUri = loginRedirectUri,
        )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    fun generateConnectUrl(
        state: String,
        scopes: List<GitHubAccessScope>,
        redirectUri: String,
    ): String {
        return "https://github.com/login/oauth/authorize" +
                "?client_id=${URLEncoder.encode(clientId, "UTF-8")}" +
                "&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}" +
                "&scope=${scopes.joinToString("%20") { URLEncoder.encode(it.value, "UTF-8") }}" +
                "&state=${URLEncoder.encode(state, "UTF-8")}" +
                "&allow_signup=true"
    }

    suspend fun exchangeCodeForToken(code: String, redirectUri: String): GitHubOAuthTokenResponse {
        return githubAuthClient.exchangeToken(
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

        val githubOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = loginRedirectUri)
        val userInfo = githubApiClient.getUser("Bearer ${githubOAuthTokenResponse.accessToken}")

        val refreshTokenExpiresAt = Instant.now().plusSeconds(githubOAuthTokenResponse.refreshTokenExpiresIn)

        val user = authRepository.associateUserWithSocialProvider(
            SocialProvider.GITHUB,
            userInfo.id.toString(),
            githubOAuthTokenResponse.refreshToken,
            refreshTokenExpiresAt,
        )

        val accessTokenKey = restClientAccessTokenKeyPrefix + user.id
        redisRepository.setValueWithExpiration(
            accessTokenKey,
            githubOAuthTokenResponse.accessToken,
            githubOAuthTokenResponse.expiresIn,
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

        val redirectUri = generateConnectUrl(
            writeToken,
            scopes = listOf(GitHubAccessScope.USER, GitHubAccessScope.USER_EMAIL),
            redirectUri = connectRedirectUri,
        )

        return ConnectInitResponse(readToken, redirectUri)
    }

    suspend fun connectSocialProfile(code: String, state: String) {
        val userId = redisRepository.getValue(userIdPrefix + state) 
            ?: throw NotFoundException("Invalid state")

        try {
            val githubOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = connectRedirectUri)
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
