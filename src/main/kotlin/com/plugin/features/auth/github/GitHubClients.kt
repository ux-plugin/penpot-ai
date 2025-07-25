package com.plugin.features.auth.github

import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient

/**
 * REST client for GitHub OAuth authentication
 */
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

/**
 * REST client for GitHub API
 */
@RegisterRestClient(configKey = "github-api")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
interface GithubApiRestClient {
    @GET
    @Path("/user")
    suspend fun getUser(@HeaderParam("Authorization") authorization: String): GitHubUser
}

/**
 * GitHub access scopes
 */
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