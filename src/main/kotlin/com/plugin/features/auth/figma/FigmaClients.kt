package com.plugin.features.auth.figma

import io.smallrye.mutiny.Uni
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient

/**
 * REST client for Figma API
 */
@RegisterRestClient(configKey = "figma-api")
@Produces(MediaType.APPLICATION_JSON)
interface FigmaRestClient {

    @POST
    @Path("/v1/oauth/token")
    @Consumes(MediaType.APPLICATION_FORM_URLENCODED)
    fun exchangeToken(
        @HeaderParam("Authorization") authorization: String,
        formData: String // Send the form data string
    ): Uni<FigmaOAuthTokenResponse>

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
    @Consumes(MediaType.APPLICATION_JSON)
    fun getMe(@HeaderParam("Authorization") authorization: String): Uni<FigmaUser>
}

/**
 * Figma access scopes
 */
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
    WEBHOOKS_WRITE("webhooks:write")
}