package com.plugin.features.auth.figma

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
import java.util.*

/**
 * Service responsible for managing Figma OAuth authentication.
 */
@ApplicationScoped
class FigmaAuthService @Inject constructor(
    @RestClient private val figmaRestClient: FigmaRestClient,

    @ConfigProperty(name = "auth.figma.client-id")
    private var clientId: String,

    @ConfigProperty(name = "auth.figma.client-secret")
    private var clientSecret: String,

    @ConfigProperty(name = "auth.figma.redirect-uri")
    private var redirectUri: String,

    @ConfigProperty(name = "auth.figma.login.random-key.max-retries")
    private var randomKeyGenerationMaxRetries: Int,

    @ConfigProperty(name = "auth.figma.login.timeout-sec")
    private var loginTimeout: Long,

    @ConfigProperty(name = "auth.figma.rest-client.access-token.redis-key-prefix")
    private var restClientAccessTokenKeyPrefix: String,

    @ConfigProperty(name = "auth.figma.read-token.redis-key-prefix")
    private var readTokenPrefix: String,

    @ConfigProperty(name = "auth.figma.write-token.redis-key-prefix")
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
            scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ)
        )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    /**
     * Generates a login URL for the user to authenticate with Figma.
     */
    fun generateLoginUrl(state: String, scopes: List<FigmaAccessScope>): String {
        val authUrl = "https://www.figma.com/oauth" +
                "?client_id=${URLEncoder.encode(clientId, "UTF-8")}" +
                "&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}" +
                "&scope=${scopes.joinToString("%2C") { URLEncoder.encode(it.value, "UTF-8") }}" +
                "&state=${URLEncoder.encode(state, "UTF-8")}" +
                "&response_type=code"
        return authUrl
    }

    /**
     * Exchanges the authorization code for a Figma access token.
     * @param code The auth code received from Figma during the OAuth redirect.
     */
    suspend fun exchangeCodeForToken(code: String): FigmaOAuthTokenResponse {
        val credentials = "$clientId:$clientSecret"
        val encodedCredentials = Base64.getEncoder().encodeToString(credentials.toByteArray())
        val authHeader = "Basic $encodedCredentials"

        val formData = listOf(
            "redirect_uri" to redirectUri,
            "code" to code,
            "grant_type" to "authorization_code"
        ).joinToString("&") { (key, value) ->
            "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}"
        }

        return try {
            figmaRestClient.exchangeToken(authHeader, formData).awaitSuspending()
        } catch (e: Exception) {
            Log.error("Failed to exchange code for token", e)
            throw e
        }
    }

    suspend fun authenticateUser(state: String, code: String) {
        // Get the read token from Redis using the write token
        val redisKey = writeTokenPrefix + state
        val readToken = redisRepository.getValue(redisKey) ?: throw NotFoundException("Invalid state")

        val figmaOAuthTokenResponse = exchangeCodeForToken(code)
        val userInfo = figmaRestClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}")
            .awaitSuspending()

        val user = authRepository.getOrAddUser(username = userInfo.email).awaitSuspending()
        
        // Store the access token in Redis
        val accessTokenKey = restClientAccessTokenKeyPrefix + user.id
        redisRepository.setValueWithExpiration(
            accessTokenKey,
            figmaOAuthTokenResponse.accessToken,
            figmaOAuthTokenResponse.expiresIn.toInt()
        )

        val refreshTokenExpiresAt = figmaOAuthTokenResponse.expiresIn.let { Instant.now().plusSeconds(it) }

        try {
            authRepository.upsertSocialLogin(
                SocialProvider.FIGMA,
                figmaOAuthTokenResponse.refreshToken,
                user.id,
                refreshTokenExpiresAt
            )
                .awaitSuspending()
        } catch (e: Exception) {
            Log.error("Failed to upsert social login", e)
            throw e
        }

        val appTokens =
            authRepository.createTokensForUser(user.id, username = user.username, role = user.role).awaitSuspending()

        val queueName = restClientAccessTokenKeyPrefix + readToken
        redisRepository.pushAccessToken(queueName, appTokens.accessToken)
    }

    suspend fun readAccessToken(readToken: String): KeyValue<String, String>? {
        val queueName = restClientAccessTokenKeyPrefix + readToken
        return redisRepository.readAccessToken(readToken = queueName, timeout = Duration.ofSeconds(loginTimeout))
    }
}