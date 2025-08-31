package com.plugin.features.auth.github

import com.plugin.features.auth.core.AccountAlreadyLinkedException
import com.plugin.features.auth.core.ConnectInitResponse
import com.plugin.features.auth.core.ConnectSocialProviderResult
import com.plugin.features.auth.core.IAuthRepository
import com.plugin.features.auth.core.IRedisRepository
import com.plugin.features.auth.core.OAuthInitResponse
import com.plugin.features.auth.core.SocialProvider
import io.quarkus.logging.Log
import io.quarkus.redis.datasource.list.KeyValue
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.NotFoundException
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.eclipse.microprofile.rest.client.inject.RestClient
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant

/**
 * Service responsible for managing GitHub OAuth authentication.
 */
@ApplicationScoped
class GitHubAuthService @Inject constructor(
    @RestClient private val githubRestClient: GithubApiRestClient,
    @RestClient private val githubAuthClient: GitHubAuthClient,

    @ConfigProperty(name = "auth.github.client-id")
    private var clientId: String,

    @ConfigProperty(name = "auth.github.client-secret")
    private var clientSecret: String,

    @ConfigProperty(name = "auth.github.login-redirect-uri")
    private var loginRedirectUri: String,

    @ConfigProperty(name = "auth.github.connect-redirect-uri")
    private var connectRedirectUri: String,

    @ConfigProperty(name = "auth.github.connect.result-key-prefix")
    private var resultKeyPrefix: String,

    @ConfigProperty(name = "auth.github.login.random-key.max-retries")
    private var randomKeyGenerationMaxRetries: Int,

    @ConfigProperty(name = "auth.github.login.timeout-sec")
    private var loginTimeout: Long,

    @ConfigProperty(name = "auth.github.rest-client.access-token.redis-key-prefix")
    private var restClientAccessTokenKeyPrefix: String,

    @ConfigProperty(name = "auth.github.read-token.redis-key-prefix")
    private var readTokenPrefix: String,

    @ConfigProperty(name = "auth.github.user-id.redis-key-prefix")
    private var userIdPrefix: String,

    @ConfigProperty(name = "auth.github.write-token.redis-key-prefix")
    private var writeTokenPrefix: String,

    private var authRepository: IAuthRepository,
    private var redisRepository: IRedisRepository
) {

    /**
     * Initializes the OAuth process by generating a unique token.
     */
    suspend fun login(): OAuthInitResponse {
        val readToken = redisRepository.generateUniqueKey(
            readTokenPrefix, 
            randomKeyGenerationMaxRetries, 
            "", 
            2 * loginTimeout.toInt()
        )
        val writeToken = redisRepository.generateUniqueKey(
            writeTokenPrefix, 
            randomKeyGenerationMaxRetries, 
            readToken, 
            2 * loginTimeout.toInt()
        )

        val tokenExpiration = Instant.now().plusSeconds(loginTimeout)
        val readTokenJwt = Jwt
            .issuer("ux-plugin")
            .subject(readToken)
            .expiresAt(tokenExpiration)
            .sign()

        val redirectUri: String = generateConnectUrl(
            writeToken,
            scopes = listOf(GitHubAccessScope.USER, GitHubAccessScope.USER_EMAIL),
            redirectUri = loginRedirectUri
        )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    /**
     * Generates a login URL for the user to authenticate with GitHub.
     */
    fun generateConnectUrl(state: String, scopes: List<GitHubAccessScope>, redirectUri: String): String {
        val authUrl = "https://github.com/login/oauth/authorize" +
                "?client_id=${URLEncoder.encode(clientId, "UTF-8")}" +
                "&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}" +
                "&scope=${scopes.joinToString("%20") { URLEncoder.encode(it.value, "UTF-8") }}" +
                "&state=${URLEncoder.encode(state, "UTF-8")}" +
                "&allow_signup=true"
        return authUrl
    }

    /**
     * Exchanges the authorization code for a GitHub access token.
     * @param code The auth code received from GitHub during the OAuth redirect.
     */
    suspend fun exchangeCodeForToken(code: String, redirectUri: String): GitHubOAuthTokenResponse {
        return try {
            // GitHub requires Accept header to return JSON
            githubAuthClient.exchangeToken(
                accept = "application/json",
                clientId = clientId,
                redirectUri = redirectUri,
                code = code,
                clientSecret = clientSecret
            )
        } catch (e: Exception) {
            Log.error("Failed to exchange code for token", e)
            throw e
        }
    }

    suspend fun authenticateUser(state: String, code: String) {
        // Get the read token from Redis using the write token
        val redisKey = writeTokenPrefix + state
        val readToken = redisRepository.getValue(redisKey) ?: throw NotFoundException("Invalid state")

        try {
            val githubOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = loginRedirectUri)
            val userInfo = githubRestClient.getUser("Bearer ${githubOAuthTokenResponse.accessToken}")

            val refreshTokenExpiresAt = Instant.now().plusSeconds(githubOAuthTokenResponse.expiresIn.toLong())

            val user = authRepository.associateUserWithSocialProvider(
                SocialProvider.GITHUB,
                userInfo.id.toString(),
                githubOAuthTokenResponse.refreshToken,
                refreshTokenExpiresAt
            )
                .awaitSuspending()
            val accessTokenKey = restClientAccessTokenKeyPrefix + user.id
            redisRepository.setValueWithExpiration(
                accessTokenKey,
                githubOAuthTokenResponse.accessToken,
                githubOAuthTokenResponse.expiresIn
            )

            val appTokens =
                authRepository.createTokensForUser(user.id, role = user.role).awaitSuspending()

            val queueName = restClientAccessTokenKeyPrefix + readToken
            redisRepository.pushAccessToken(queueName, appTokens.accessToken)
        } catch (e: Exception) {
            Log.error("Failed to upsert social login", e)
            throw e
        }
    }

    suspend fun readAccessToken(readToken: String): KeyValue<String, String>? {
        val queueName = restClientAccessTokenKeyPrefix + readToken
        return redisRepository.readAccessToken(readToken = queueName, timeout = Duration.ofSeconds(loginTimeout))
    }

    suspend fun connectInitiate(userId: String): ConnectInitResponse {
        val readToken = redisRepository.generateUniqueKey(
            readTokenPrefix,
            randomKeyGenerationMaxRetries,
            "",
            2 * loginTimeout.toInt()
        )
        val writeToken = redisRepository.generateUniqueKey(
            writeTokenPrefix,
            randomKeyGenerationMaxRetries,
            readToken,
            2 * loginTimeout.toInt()
        )
        redisRepository.setValueWithExpiration(userIdPrefix + writeToken, userId, 2 * loginTimeout.toInt())

        val redirectUri: String = generateConnectUrl(
            writeToken,
            scopes = listOf(GitHubAccessScope.USER, GitHubAccessScope.USER_EMAIL),
            redirectUri = connectRedirectUri
        )

        return ConnectInitResponse(readToken, redirectUri)
    }

    suspend fun connectSocialProfile(code: String, state: String) {
        // Get the read token from Redis using the writing token
        val userId = redisRepository.getValue(userIdPrefix + state) ?: throw NotFoundException("Invalid state")

        try {
            val githubOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = connectRedirectUri)
            val userInfo = githubRestClient.getUser("Bearer ${githubOAuthTokenResponse.accessToken}")
            val refreshTokenExpiresAt = Instant.now().plusSeconds(githubOAuthTokenResponse.expiresIn.toLong())

            val socialProfile = authRepository.getSocialLogin("${userInfo.id}", SocialProvider.GITHUB)
                .awaitSuspending()
            if (socialProfile != null && socialProfile.providerUserId != userInfo.id.toString()) {
                throw AccountAlreadyLinkedException("Account already linked.")
            }
            if (socialProfile == null) {
                authRepository.insertSocialLogin(provider = SocialProvider.GITHUB, userId = userId, providerUserId = userInfo.id.toString(), refreshToken = githubOAuthTokenResponse.refreshToken, refreshTokenExpiresAt = refreshTokenExpiresAt).awaitSuspending()
            }

            val queueName = resultKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.SUCCESS.value)
        } catch (e: Exception) {
            Log.error("Failed to upsert social login", e)
            val queueName = resultKeyPrefix + userId
            redisRepository.pushAccessToken(queueName, ConnectSocialProviderResult.FAILURE.value)
            throw e
        }
    }

    suspend fun getConnectResult(userId: String): KeyValue<String, String>? {
        val queueName = resultKeyPrefix + userId
        return redisRepository.readAccessToken(readToken = queueName, timeout = Duration.ofSeconds(loginTimeout))
    }
}