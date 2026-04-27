package com.plugin.features.auth.auth0

import com.plugin.config.properties.Auth0Properties
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.reactive.function.BodyInserters
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody

@Component
@ConditionalOnProperty(prefix = "auth0.oauth", name = ["client-id"])
class Auth0AuthClient(webClientBuilder: WebClient.Builder, private val auth0Properties: Auth0Properties) {
    private val webClient = webClientBuilder.build()

    suspend fun exchangeCodeForToken(code: String, redirectUri: String): Auth0OAuthTokenResponse {
        val tokenUrl = requireNotNull(auth0Properties.resolvedTokenUrl()) { "auth0.issuer is not configured" }
        val oauth = auth0Properties.oauth
        val formData =
            LinkedMultiValueMap<String, String>().apply {
                add("grant_type", "authorization_code")
                add("client_id", requireNotNull(oauth.clientId))
                add("client_secret", requireNotNull(oauth.clientSecret))
                add("code", code)
                add("redirect_uri", redirectUri)
            }
        return webClient
            .post()
            .uri(tokenUrl)
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .accept(MediaType.APPLICATION_JSON)
            .body(BodyInserters.fromFormData(formData))
            .retrieve()
            .awaitBody<Auth0OAuthTokenResponse>()
    }

    suspend fun refreshToken(refreshToken: String): Auth0OAuthTokenResponse {
        val tokenUrl = requireNotNull(auth0Properties.resolvedTokenUrl()) { "auth0.issuer is not configured" }
        val oauth = auth0Properties.oauth
        val formData =
            LinkedMultiValueMap<String, String>().apply {
                add("grant_type", "refresh_token")
                add("client_id", requireNotNull(oauth.clientId))
                add("client_secret", requireNotNull(oauth.clientSecret))
                add("refresh_token", refreshToken)
            }
        return webClient
            .post()
            .uri(tokenUrl)
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .accept(MediaType.APPLICATION_JSON)
            .body(BodyInserters.fromFormData(formData))
            .retrieve()
            .awaitBody<Auth0OAuthTokenResponse>()
    }
}
