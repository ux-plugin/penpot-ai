package com.plugin.api.features.auth.figma

import com.fasterxml.jackson.annotation.JsonProperty

/** Data Transfer Objects for Figma authentication */

/** Figma OAuth token response */
data class FigmaOAuthTokenResponse(
    @JsonProperty("user_id_string") val userIdString: String?,
    @JsonProperty("user_id") val userId: Long,
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("token_type") val tokenType: String,
    @JsonProperty("expires_in") val expiresIn: Long,
    @JsonProperty("refresh_token") val refreshToken: String,
)

/** Figma refresh token response */
data class FigmaRefreshTokenResponse(
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("token_type") val tokenType: String,
    @JsonProperty("expires_in") val expiresIn: Int,
)

/** Figma user information */
data class FigmaUser(val id: String, val handle: String, @JsonProperty("img_url") val imgUrl: String, val email: String)

/** Figma access scopes */
enum class FigmaAccessScope(val value: String) {
    CURRENT_USER_READ("current_user:read"),
    FILE_COMMENTS_READ("file_comments:read"),
    FILE_COMMENTS_WRITE("file_comments:write"),
    FILE_CONTENT_READ("file_content:read"),
    FILE_DEV_RESOURCES_READ("file_dev_resources:read"),
    FILE_DEV_RESOURCES_WRITE("file_dev_resources:write"),
    FILE_METADATA_READ("file_metadata:read"),
    FILE_VARIABLES_READ("file_variables:read"),
    FILE_VARIABLES_WRITE("file_variables:write"),
    FILE_VERSIONS_READ("file_versions:read"),
    LIBRARY_ANALYTICS_READ("library_analytics:read"),
    LIBRARY_ASSETS_READ("library_assets:read"),
    LIBRARY_CONTENT_READ("library_content:read"),
    ORG_ACTIVITY_LOG_READ("org:activity_log_read"),
    ORG_DISCOVERY_READ("org:discovery_read"),
    PROJECTS_READ("projects:read"),
    TEAM_LIBRARY_CONTENT_READ("team_library_content:read"),
    WEBHOOKS_READ("webhooks:read"),
    WEBHOOKS_WRITE("webhooks:write"),
}
