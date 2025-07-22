package com.plugin.features.auth

import io.quarkus.logging.Log
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.list.KeyValue
import io.quarkus.redis.datasource.list.ReactiveListCommands
import io.quarkus.redis.datasource.value.ReactiveValueCommands
import io.quarkus.redis.datasource.value.SetArgs
import io.quarkus.security.Authenticated
import io.quarkus.security.identity.SecurityIdentity
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.coroutines.awaitSuspending
import io.vertx.mutiny.redis.client.Command
import io.vertx.mutiny.redis.client.Request
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient
import org.eclipse.microprofile.rest.client.inject.RestClient
import java.net.URLEncoder
import java.time.Duration
import java.time.Instant
import java.util.*

@RegisterRestClient(configKey = "figma-api")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
interface FigmaRestClient {

    @POST
    @Path("/v1/oauth/token")
    @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
    fun exchangeToken(
        @HeaderParam("Authorization") authorization: String,
        formData: String // Send the form data string
    ): Uni<FigmaOAuthTokenResponse> // Use Uni or CompletionStage instead of suspend.

    @POST
    @Path("/v1/oauth/token")
    @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
    fun refreshToken(
        @HeaderParam("Authorization") authorization: String,
        @FormParam("refresh_token") refreshToken: String,
        @FormParam("grant_type") grantType: String
    ): Uni<FigmaRefreshTokenResponse>

    @GET
    @Path("/v1/me")
    fun getMe(@HeaderParam("Authorization") authorization: String): Uni<FigmaUser>
}

data class FigmaRefreshTokenResponse(
    val access_token: String,
    val token_type: String,
    val expires_in: Int
)

data class FigmaUser(
    val id: String, // Unique stable id of the user
    val handle: String, // Name of the user
    val img_url: String, // URL link to the user's profile image
    val email: String // Email associated with the user's account (only present on /v1/me endpoint)
)

enum class FigmaAccessScope(val value: String) {
    CURRENT_USER_READ("current_user:read"), // Read your name, email, and profile image.
    FILE_COMMENTS_READ("file_comments:read"), // Read the comments for files.
    FILE_COMMENTS_WRITE("file_comments:write"), // Post and delete comments and comment reactions in files.
    FILE_CONTENT_READ("file_content:read"), // Read the contents of files, such as nodes and the editor type.
    FILE_DEV_RESOURCES_READ("file_dev_resources:read"), // Read dev resources in files.
    FILE_DEV_RESOURCES_WRITE("file_dev_resources:write"), // Write dev resources to files.
    FILE_METADATA_READ("file_metadata:read"), // Read metadata of files.
    FILE_VARIABLES_READ("file_variables:read"), // Read variables in files. Note: Enterprise plan only.
    FILE_VARIABLES_WRITE("file_variables:write"), // Write variables and collections in files. Note: Enterprise plan only.
    FILE_VERSIONS_READ("file_versions:read"), // Read the version history for files you can access.
    LIBRARY_ANALYTICS_READ("library_analytics:read"), // Read your design system analytics. Note: Enterprise plan only.
    LIBRARY_ASSETS_READ("library_assets:read"), // Read data of individual published components and styles.
    LIBRARY_CONTENT_READ("library_content:read"), // Read published components and styles of files.
    ORG_ACTIVITY_LOG_READ("org:activity_log_read"), // Read organization activity logs. Note: Enterprise plan only. Must be an organization admin.
    ORG_DISCOVERY_READ("org:discovery_read"), // Read text event data in the organization. Note: Enterprise plans with Governance+ only. Must be an organization admin.
    PROJECTS_READ("projects:read"), // List projects and files in projects.
    TEAM_LIBRARY_CONTENT_READ("team_library_content:read"), // Read published components and styles of teams.
    WEBHOOKS_READ("webhooks:read"), // Read metadata of webhooks.
    WEBHOOKS_WRITE("webhooks:write") // Write metadata of webhooks.
}

/**
 * Service responsible for managing Figma OAuth authentication.
 */
@ApplicationScoped
class FigmaAuthService @Inject constructor(
    @RestClient private val figmaRestClient: FigmaRestClient,
    reactiveRedisDataSource: ReactiveRedisDataSource,
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

    val redisClient: ReactiveRedisDataSource,

    private var authRepository: IAuthRepository,
) {

    private val redisQueue: ReactiveListCommands<String, String> =
        reactiveRedisDataSource.list(String::class.java)

    private val redisCommands: ReactiveValueCommands<String, String> = reactiveRedisDataSource.value(String::class.java)

    suspend fun setnxex(key: String, value: String, expiresIn: Int): Boolean {
        val request = Request.cmd(Command.SET)
            .arg(key)
            .arg(value)
            .arg("NX")
            .arg("EX")
            .arg(expiresIn)
        return redisClient.redis.send(request).onItem().transform { it != null }.awaitSuspending()
    }

    /**
     * Initializes the OAuth process by generating a unique token.
     */
    suspend fun login(): OAuthInitResponse {
        val readToken = generateUniqueKey(readTokenPrefix, randomKeyGenerationMaxRetries, "", 2 * loginTimeout.toInt())
        val writeToken =
            generateUniqueKey(writeTokenPrefix, randomKeyGenerationMaxRetries, readToken, 2 * loginTimeout.toInt())

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

    private suspend fun generateUniqueKey(
        prefix: String,
        maxRetries: Int,
        valueOfKey: String,
        expiresIn: Int = 5,
    ): String {
        var numberOfGenerationAttempts = 0
        while (numberOfGenerationAttempts < maxRetries) {
            val uniqueToken = UUID.randomUUID().toString()
            val key = prefix + uniqueToken
            if (setnxex(key, valueOfKey, expiresIn)) {
                return uniqueToken // Success!
            }
            numberOfGenerationAttempts++
            Log.warn("Key $key already exists, generating a new one")
        }
        throw IllegalStateException("Failed to generate a unique key after $maxRetries attempts")
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
        val readToken =
            redisCommands.get(writeTokenPrefix + state).awaitSuspending() ?: throw NotFoundException("Invalid state")

        val figmaOAuthTokenResponse = exchangeCodeForToken(code)
        val userInfo = figmaRestClient.getMe("Bearer ${figmaOAuthTokenResponse.accessToken}")
            .awaitSuspending()

        val user = authRepository.getOrAddUser(username = userInfo.email).awaitSuspending()
        redisCommands.setex(
            restClientAccessTokenKeyPrefix + user.id,
            figmaOAuthTokenResponse.expiresIn,
            figmaOAuthTokenResponse.accessToken
        )
            .awaitSuspending()

        try {
            authRepository.upsertSocialLogin(SocialProvider.FIGMA, figmaOAuthTokenResponse.refreshToken, user.id)
                .awaitSuspending()
        } catch (e: Exception) {
            Log.error("Failed to upsert social login", e)
            throw e
        }

        val appTokens =
            authRepository.createTokensForUser(user.id, username = user.username, role = user.role).awaitSuspending()

        val queueName = restClientAccessTokenKeyPrefix + readToken
        redisQueue.lpush(queueName, appTokens.accessToken).awaitSuspending()
    }

    suspend fun readAccessToken(readToken: String): KeyValue<String, String>? {
        val queueName = restClientAccessTokenKeyPrefix + readToken
        return redisQueue.blpop(
            Duration.ofSeconds(loginTimeout), queueName
        ).awaitSuspending()
    }

    suspend fun test() {
        val res = redisCommands.set("test", "abc", SetArgs().nx().ex(100)).awaitSuspending()
        val res2 = redisCommands.set("test", "abc", SetArgs().nx().ex(100)).awaitSuspending()
        println("$res , $res2")
    }
}

/**
 * REST resource for handling Figma OAuth authentication.
 */
@Path("/auth/figma")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
class FigmaAuthResource @Inject constructor(
    private val figmaAuthService: FigmaAuthService,
    private val securityIdentity: SecurityIdentity,
) {

    @GET
    @Path("/login")
    suspend fun login(): Response {
        return try {
            val response = figmaAuthService.login()
            Response.ok(response).build()
        } catch (e: Exception) {
            Log.error("Failed to login", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Failed to login").build()
        }
    }

    @GET
    @Path("/callback")
    suspend fun callback(@QueryParam("code") code: String, @QueryParam("state") state: String): Response {
        return try {
            figmaAuthService.authenticateUser(state, code)
            Response.ok().build()
        } catch (e: Exception) {
            Log.error("Failed to authenticate", e)
            Response.status(Response.Status.BAD_REQUEST).entity("Failed to authenticate").build()
        }
    }

    @GET
    @Path("/access-token")
    @Authenticated
    open suspend fun getAppAccessToken(): Response {
        val readToken = securityIdentity.principal.name
        val token = figmaAuthService.readAccessToken(readToken)
        return if (token == null || token.value == null) {
            Log.error("Produced access token is null")
            Response.status(Response.Status.REQUEST_TIMEOUT).build()
        } else {
            Response.ok(ReadTokenResponse(token.value)).build()
        }
    }
}