package com.plugin.api.features.auth.figma

import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.util.LinkedMultiValueMap
import org.springframework.web.reactive.function.BodyInserters
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody
import java.util.*

@Component
class FigmaAuthClient(private val webClientBuilder: WebClient.Builder) {
    private val webClient = webClientBuilder.baseUrl("https://api.figma.com").build()

    suspend fun exchangeToken(clientId: String, clientSecret: String, code: String, redirectUri: String): FigmaOAuthTokenResponse {
        val credentials = "$clientId:$clientSecret"
        val encodedCredentials = Base64.getEncoder().encodeToString(credentials.toByteArray())
        val authHeader = "Basic $encodedCredentials"

        val formData =
            LinkedMultiValueMap<String, String>().apply {
                add("redirect_uri", redirectUri)
                add("code", code)
                add("grant_type", "authorization_code")
            }

        return webClient
            .post()
            .uri("/v1/oauth/token")
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .header("Authorization", authHeader)
            .body(BodyInserters.fromFormData(formData))
            .retrieve()
            .awaitBody<FigmaOAuthTokenResponse>()
    }

    suspend fun refreshToken(clientId: String, clientSecret: String, refreshToken: String): FigmaRefreshTokenResponse {
        val credentials = "$clientId:$clientSecret"
        val encodedCredentials = Base64.getEncoder().encodeToString(credentials.toByteArray())
        val authHeader = "Basic $encodedCredentials"

        val formData =
            LinkedMultiValueMap<String, String>().apply {
                add("refresh_token", refreshToken)
                add("grant_type", "refresh_token")
            }

        return webClient
            .post()
            .uri("/v1/oauth/token")
            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
            .header("Authorization", authHeader)
            .body(BodyInserters.fromFormData(formData))
            .retrieve()
            .awaitBody<FigmaRefreshTokenResponse>()
    }
}

@Component
class FigmaApiClient(private val webClientBuilder: WebClient.Builder) {
    private val webClient = webClientBuilder.baseUrl("https://api.figma.com").build()

    suspend fun getMe(authorization: String): FigmaUser = webClient
        .get()
        .uri("/v1/me")
        .header("Authorization", authorization)
        .accept(MediaType.APPLICATION_JSON)
        .retrieve()
        .awaitBody<FigmaUser>()
}
