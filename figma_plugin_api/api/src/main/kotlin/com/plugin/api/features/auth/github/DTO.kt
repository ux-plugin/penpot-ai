package com.plugin.api.features.auth.github

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty

/** Data Transfer Objects for GitHub authentication */

/** GitHub OAuth token response */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class GitHubOAuthTokenResponse(
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("expires_in") val expiresIn: Long,
    @JsonProperty("refresh_token") val refreshToken: String,
    @JsonProperty("refresh_token_expires_in") val refreshTokenExpiresIn: Long,
    @JsonProperty("scope") val scope: String = "",
    @JsonProperty("token_type") val tokenType: String = "bearer",
)

/** GitHub user information */
data class GitHubUser(
    val id: Long,
    val login: String,
    @JsonProperty("avatar_url") val avatarUrl: String,
    val email: String?,
    val name: String?,
)

/** GitHub access scopes */
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
    READ_AUDIT_LOG("read:audit_log"),
}
