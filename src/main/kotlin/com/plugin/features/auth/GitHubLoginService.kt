package com.plugin.features.auth

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import io.quarkus.logging.Log
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.list.KeyValue
import io.quarkus.redis.datasource.list.ReactiveListCommands
import io.quarkus.redis.datasource.value.ReactiveValueCommands
import io.quarkus.security.Authenticated
import io.quarkus.security.identity.SecurityIdentity
import io.smallrye.jwt.build.Jwt
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

@RegisterRestClient(configKey = "github-auth")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
interface GitHubAuthClient {

    @POST
    @Path("/login/oauth/access_token")
    @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
    suspend fun exchangeToken(
        @HeaderParam("Accept") accept: String,
        @FormParam("client_id") clientId: String,
        @FormParam("client_secret") clientSecret: String,
        @FormParam("code") code: String,
        @FormParam("redirect_uri") redirectUri: String,
    ): GitHubOAuthTokenResponse


    @GET
    @Path("/login/oauth/authorize")
    suspend fun authorize(
        @QueryParam("client_id") clientId: String,
        @QueryParam("redirect_uri") redirectUri: String,
        @QueryParam("state") state: String,
        @QueryParam("scope") scope: String,
    ): Response
}

@RegisterRestClient(configKey = "github-api")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
interface GithubApiRestClient {
    @GET
    @Path("/user")
    suspend fun getUser(@HeaderParam("Authorization") authorization: String): GitHubUser
}

@JsonInclude(JsonInclude.Include.NON_NULL)
data class GitHubOAuthTokenResponse(
    @JsonProperty("access_token")
    val accessToken: String,
    @JsonProperty("expires_in")
    val expiresIn: Int? = null,
    @JsonProperty("refresh_token")
    val refreshToken: String,
    @JsonProperty("refresh_token_expires_in")
    val refreshTokenExpiresIn: Int? = null,
    @JsonProperty("scope")
    val scope: String = "",
    @JsonProperty("token_type")
    val tokenType: String = "bearer"
)


data class GitHubUser(
    val id: Long,
    val login: String,
    @JsonProperty("avatar_url") val avatarUrl: String,
    val email: String?,
    val name: String?
)

enum class GitHubAccessScope(val value: String) {
    REPO("repo"),
    REPO_STATUS("repo:status"),
    REPO_DEPLOYMENT("repo_deployment"),
    PUBLIC_REPO("public_repo"),
    REPO_INVITE("repo:invite"),
    SECURITY_EVENTS("security_events"),
    ADMIN_REPO_HOOK("admin:repo_hook"),
    WRITE_REPO_HOOK("write:repo_hook"),
    READ_REPO_HOOK("read:repo_hook"),
    ADMIN_ORG("admin:org"),
    WRITE_ORG("write:org"),
    READ_ORG("read:org"),
    ADMIN_PUBLIC_KEY("admin:public_key"),
    WRITE_PUBLIC_KEY("write:public_key"),
    READ_PUBLIC_KEY("read:public_key"),
    ADMIN_ORG_HOOK("admin:org_hook"),
    GIST("gist"),
    NOTIFICATIONS("notifications"),
    USER("user"),
    READ_USER("read:user"),
    USER_EMAIL("user:email"),
    USER_FOLLOW("user:follow"),
    PROJECT("project"),
    READ_PROJECT("read:project"),
    DELETE_REPO("delete_repo"),
    WRITE_PACKAGES("write:packages"),
    READ_PACKAGES("read:packages"),
    DELETE_PACKAGES("delete:packages"),
    ADMIN_GPG_KEY("admin:gpg_key"),
    WRITE_GPG_KEY("write:gpg_key"),
    READ_GPG_KEY("read:gpg_key"),
    CODESPACE("codespace"),
    WORKFLOW("workflow"),
    READ_AUDIT_LOG("read:audit_log")
}

/**
 * Service responsible for managing GitHub OAuth authentication.
 */
@ApplicationScoped
class GitHubAuthService @Inject constructor(
    @RestClient private val githubRestClient: GithubApiRestClient,
    @RestClient private val githubAuthClient: GitHubAuthClient,

    reactiveRedisDataSource: ReactiveRedisDataSource,
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
        val readToken =
            redisCommands.get(writeTokenPrefix + state).awaitSuspending() ?: throw NotFoundException("Invalid state")

        val githubOAuthTokenResponse = exchangeCodeForToken(code = code, state = state)
        val userInfo = githubRestClient.getUser("Bearer ${githubOAuthTokenResponse.accessToken}")

        // Use login as username if email is null
        val username = userInfo.email ?: userInfo.login
        val user = authRepository.getOrAddUser(username = username).awaitSuspending()

        // GitHub doesn't provide a refresh token, so we store the access token as the refresh token
        try {
            authRepository.upsertSocialLogin(SocialProvider.GITHUB, githubOAuthTokenResponse.refreshToken, user.id)
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
}

/**
 * REST resource for handling GitHub OAuth authentication.
 */
@Path("/auth/github")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
class GitHubAuthResource @Inject constructor(
    private val githubAuthService: GitHubAuthService,
    private val securityIdentity: SecurityIdentity,
) {

    @GET
    @Path("/login")
    suspend fun login(): Response {
        return try {
            val response = githubAuthService.login()
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
            githubAuthService.authenticateUser(state, code)
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
        val token = githubAuthService.readAccessToken(readToken)
        return if (token == null || token.value == null) {
            Log.error("Produced access token is null")
            Response.status(Response.Status.REQUEST_TIMEOUT).build()
        } else {
            Response.ok(ReadTokenResponse(token.value)).build()
        }
    }
}