package com.plugin.features.auth.figma

import com.plugin.features.auth.core.*
import io.quarkus.logging.Log
import io.quarkus.redis.datasource.list.KeyValue
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.NotFoundException
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant
import java.util.*
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.eclipse.microprofile.rest.client.inject.RestClient

/** Service responsible for managing Figma OAuth authentication. */
@ApplicationScoped
class FigmaAuthService
@Inject
constructor(
    @RestClient private val figmaRestClient: FigmaRestClient,
    @ConfigProperty(name = "auth.figma.client-id") private var clientId: String,
    @ConfigProperty(name = "auth.figma.client-secret") private var clientSecret: String,
    @ConfigProperty(name = "auth.figma.login-redirect-uri") private var loginRedirectUri: String,
    @ConfigProperty(name = "auth.figma.connect-redirect-uri") private var connectRedirectUri: String,
    @ConfigProperty(name = "auth.figma.connect.redis-key-prefix", defaultValue = "figma-connect:")
    private var resultKeyPrefix: String,
    @ConfigProperty(name = "auth.figma.user-id.result-key-prefix", defaultValue = "figma-user-id:")
    private var userIdPrefix: String,
    @ConfigProperty(name = "auth.figma.login.random-key.max-retries") private var randomKeyGenerationMaxRetries: Int,
    @ConfigProperty(name = "auth.figma.login.timeout-sec") private var loginTimeout: Long,
    @ConfigProperty(name = "auth.figma.rest-client.access-token.redis-key-prefix")
    private var restClientAccessTokenKeyPrefix: String,
    @ConfigProperty(name = "auth.figma.read-token.redis-key-prefix") private var readTokenPrefix: String,
    @ConfigProperty(name = "auth.figma.write-token.redis-key-prefix") private var writeTokenPrefix: String,
    private var authRepository: AuthRepository,
    private var redisRepository: RedisRepository,
) {

    /** Initializes the OAuth process by generating a unique token. */
    suspend fun login(): OAuthInitResponse {
        val readToken =
            redisRepository.generateUniqueKey(
                readTokenPrefix,
                randomKeyGenerationMaxRetries,
                "",
                2 * loginTimeout.toInt(),
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                writeTokenPrefix,
                randomKeyGenerationMaxRetries,
                readToken,
                2 * loginTimeout.toInt(),
            )

        val tokenExpiration = Instant.now().plusSeconds(loginTimeout)
        val readTokenJwt = Jwt.issuer("ux-plugin").subject(readToken).expiresAt(tokenExpiration).sign()

        val redirectUri: String =
            generateOAuthUrl(
                writeToken,
                scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ),
                redirectUri = loginRedirectUri,
            )
        return OAuthInitResponse(readTokenJwt, redirectUri)
    }

    /**
     * Generates a Figma OAuth URL for authentication.
     *
     * @param state The state parameter for OAuth flow
     * @param scopes The list of scopes to request
     * @param redirectUri The URI to redirect to after authentication
     * @return The complete OAuth URL
     */
    fun generateOAuthUrl(
        state: String,
        scopes: List<FigmaAccessScope>,
        redirectUri: String,
    ): String {
        val authUrl =
            "https://www.figma.com/oauth" +
                "?client_id=${URLEncoder.encode(clientId, "UTF-8")}" +
                "&redirect_uri=${URLEncoder.encode(redirectUri, "UTF-8")}" +
                "&scope=${scopes.joinToString("%2C") { URLEncoder.encode(it.value, "UTF-8") }}" +
                "&state=${URLEncoder.encode(state, "UTF-8")}" +
                "&response_type=code"
        return authUrl
    }

    /**
     * Generates a connect URL for the user to authenticate with Figma.
     *
     * @deprecated Use generateOAuthUrl(state, scopes, connectRedirectUri) instead
     */
    @Deprecated(
        "Use generateOAuthUrl instead",
        ReplaceWith("generateOAuthUrl(state, scopes, connectRedirectUri)"),
    )
    fun generateConnectUrl(state: String, scopes: List<FigmaAccessScope>): String =
        generateOAuthUrl(state, scopes, connectRedirectUri)

    suspend fun exchangeCodeForToken(code: String, redirectUri: String): FigmaOAuthTokenResponse {
        val credentials = "$clientId:$clientSecret"
        val encodedCredentials = Base64.getEncoder().encodeToString(credentials.toByteArray())
        val authHeader = "Basic $encodedCredentials"

        val formData =
            listOf(
                    "redirect_uri" to redirectUri,
                    "code" to code,
                    "grant_type" to "authorization_code",
                )
                .joinToString("&") { (key, value) ->
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
        try {

            val figmaOAuthTokenResponse = exchangeCodeForToken(code, redirectUri = loginRedirectUri)
            val userInfo = figmaRestClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}").awaitSuspending()

            val refreshTokenExpiresAt = figmaOAuthTokenResponse.expiresIn.let { Instant.now().plusSeconds(it) }

            val user =
                authRepository
                    .associateUserWithSocialProvider(
                        SocialProvider.FIGMA,
                        userInfo.id,
                        figmaOAuthTokenResponse.refreshToken,
                        refreshTokenExpiresAt,
                    )
                    .awaitSuspending()

            // Store the figma rest client access token in Redis
            val accessTokenKey = restClientAccessTokenKeyPrefix + user.id
            redisRepository.setValueWithExpiration(
                accessTokenKey,
                figmaOAuthTokenResponse.accessToken,
                figmaOAuthTokenResponse.expiresIn.toInt(),
            )

            val appTokens = authRepository.createTokensForUser(user.id, role = user.role).awaitSuspending()

            val queueName = restClientAccessTokenKeyPrefix + readToken
            redisRepository.pushAccessToken(queueName, appTokens.accessToken)
        } catch (e: Exception) {
            Log.error("Failed to upsert social login", e)
            throw e
        }
    }

    suspend fun readAccessToken(readToken: String): KeyValue<String, String>? {
        val queueName = restClientAccessTokenKeyPrefix + readToken
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(loginTimeout),
        )
    }

    suspend fun connectInitiate(userId: String): ConnectInitResponse {
        val readToken =
            redisRepository.generateUniqueKey(
                readTokenPrefix,
                randomKeyGenerationMaxRetries,
                "",
                2 * loginTimeout.toInt(),
            )
        val writeToken =
            redisRepository.generateUniqueKey(
                writeTokenPrefix,
                randomKeyGenerationMaxRetries,
                readToken,
                2 * loginTimeout.toInt(),
            )
        redisRepository.setValueWithExpiration(
            userIdPrefix + writeToken,
            userId,
            2 * loginTimeout.toInt(),
        )

        val redirectUri: String =
            generateOAuthUrl(
                writeToken,
                scopes = listOf(FigmaAccessScope.CURRENT_USER_READ, FigmaAccessScope.FILE_CONTENT_READ),
                redirectUri = connectRedirectUri,
            )

        return ConnectInitResponse(readToken, redirectUri)
    }

    suspend fun connectSocialProfile(code: String, state: String) {
        val userId = redisRepository.getValue(userIdPrefix + state) ?: throw NotFoundException("Invalid state")
        try {
            val figmaOAuthTokenResponse = exchangeCodeForToken(code = code, redirectUri = connectRedirectUri)
            val userInfo = figmaRestClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}").awaitSuspending()
            val refreshTokenExpiresAt = Instant.now().plusSeconds(figmaOAuthTokenResponse.expiresIn)

            val socialProfile = authRepository.getSocialLogin(userInfo.id, SocialProvider.FIGMA).awaitSuspending()
            if (socialProfile != null && socialProfile.providerUserId != userInfo.id) {
                throw AccountAlreadyLinkedException("Account already linked.")
            }
            if (socialProfile == null) {
                authRepository
                    .insertSocialLogin(
                        provider = SocialProvider.FIGMA,
                        userId = userId,
                        providerUserId = userInfo.id,
                        refreshToken = figmaOAuthTokenResponse.refreshToken,
                        refreshTokenExpiresAt = refreshTokenExpiresAt,
                    )
                    .awaitSuspending()
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
        return redisRepository.readAccessToken(
            readToken = queueName,
            timeout = Duration.ofSeconds(loginTimeout),
        )
    }
}
