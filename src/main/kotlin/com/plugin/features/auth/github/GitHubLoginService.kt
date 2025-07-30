package com.plugin.features.auth.github

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

    @ConfigProperty(name = "auth.github.redirect-uri")
    private var redirectUri: String,

    @ConfigProperty(name = "auth.github.login.random-key.max-retries")
    private var randomKeyGenerationMaxRetries: Int,

    @ConfigProperty(name = "auth.github.login.timeout-sec")
    private var loginTimeout: Long,

    @ConfigProperty(name = "auth.github.rest-client.access-token.redis-key-prefix")
    private var restClientAccessTokenKeyPrefix: String,

    @ConfigProperty(name = "auth.github.read-token.redis-key-prefix")
    private var readTokenPrefix: String,

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

        val redirectUri: String = generateLoginUrl(
            writeToken,
            scopes = listOf(GitHubAccessScope.USER, GitHubAccessScope.USER_EMAIL)
        )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    /**
     * Generates a login URL for the user to authenticate with GitHub.
     */
    fun generateLoginUrl(state: String, scopes: List<GitHubAccessScope>): String {
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
    suspend fun exchangeCodeForToken(code: String, state: String): GitHubOAuthTokenResponse {
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

        val githubOAuthTokenResponse = exchangeCodeForToken(code = code, state = state)
        val userInfo = githubRestClient.getUser("Bearer ${githubOAuthTokenResponse.accessToken}")

        val refreshTokenExpiresAt = Instant.now().plusSeconds(githubOAuthTokenResponse.expiresIn.toLong())

        // GitHub doesn't provide a refresh token, so we store the access token as the refresh token
        try {
            val user = authRepository.associateUserWithSocialProvider(
                userInfo.email?: "",
                SocialProvider.GITHUB,
                userInfo.id.toString(),
                githubOAuthTokenResponse.refreshToken,
                refreshTokenExpiresAt
            )
                .awaitSuspending()
            // Store the access token in Redis
            val accessTokenKey = restClientAccessTokenKeyPrefix + user.id
            redisRepository.setValueWithExpiration(
                accessTokenKey,
                githubOAuthTokenResponse.accessToken,
                githubOAuthTokenResponse.expiresIn
            )

            val appTokens =
                authRepository.createTokensForUser(user.id, username = user.username, role = user.role).awaitSuspending()

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
}