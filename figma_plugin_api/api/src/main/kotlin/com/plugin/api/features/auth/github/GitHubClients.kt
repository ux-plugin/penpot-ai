package com.plugin.api.features.auth.github

import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.reactive.function.BodyInserters
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody

@Component
class GitHubAuthClient(private val webClientBuilder: WebClient.Builder) {
    private val webClient = webClientBuilder.baseUrl("https://github.com").build()

    suspend fun exchangeToken(clientId: String, clientSecret: String, code: String, redirectUri: String): GitHubOAuthTokenResponse {
        val formData =
            LinkedMultiValueMap<String, String>().apply {
                add("client_id", clientId)
                add("client_secret", clientSecret)
                add("code", code)
                add("redirect_uri", redirectUri)
            }

        return webClient
            .post()
            .uri("/login/oauth/access_token")
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .accept(MediaType.APPLICATION_JSON)
            .body(BodyInserters.fromFormData(formData))
            .retrieve()
            .awaitBody<GitHubOAuthTokenResponse>()
    }
}

@Component
class GitHubApiClient(private val webClientBuilder: WebClient.Builder) {
    private val webClient = webClientBuilder.baseUrl("https://api.github.com").build()

    suspend fun getUser(authorization: String): GitHubUser = webClient
        .get()
        .uri("/user")
        .header("Authorization", authorization)
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .awaitBody<GitHubUser>()
}
