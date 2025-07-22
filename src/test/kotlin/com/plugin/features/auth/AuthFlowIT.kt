package com.plugin.features.auth

import com.plugin.shared.PostgresTestResourceManager
import com.plugin.shared.RedisTestResourceManager
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.restassured.RestAssured.given
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.hamcrest.CoreMatchers.containsString
import org.hamcrest.CoreMatchers.notNullValue
import org.junit.jupiter.api.Test

@QuarkusTest
@QuarkusTestResource(PostgresTestResourceManager::class, parallel = true)
@QuarkusTestResource(RedisTestResourceManager::class, parallel = true)
@QuarkusTestResource(MockFigmaAuthInfra::class, parallel = true)
class AuthFlowIT {

    @Test
    fun testFigmaLoginFlowWithCallbackFunction() {
        val response = given()
            .`when`()
            .get("/auth/figma/login")
            .then()
            .statusCode(200)
            .body("readTokenJwt", notNullValue())
            .body("loginUrl", containsString("https://www.figma.com/oauth"))
            .body("loginUrl", containsString("client_id="))
            .body("loginUrl", containsString("redirect_uri="))
            .extract()
            .response()

        val loginUrl = response.jsonPath().getString("loginUrl")
        val state = loginUrl.substringAfter("state=").substringBefore("&")
        val readTokenJwt = response.jsonPath().getString("readTokenJwt")

        runBlocking {
            launch(Dispatchers.IO) {
                val response = given()
                    .header("Authorization", "Bearer $readTokenJwt")
                    .`when`()
                    .get("/auth/figma/access-token")
                    .then()
                    .statusCode(200)
                    .body("accessToken", notNullValue())
                    .extract()
                    .response()

                val accessToken = response.jsonPath().getString("accessToken")

                given()
                    .header("Authorization", "Bearer $accessToken")
                    .`when`()
                    .get("/auth/refresh-token")
                    .then()
                    .statusCode(200)
                    .cookie("refresh_token", notNullValue())
            }

            launch(Dispatchers.IO) {
                given()
                    .queryParam("code", "test-code")
                    .queryParam("state", state)
                    .`when`()
                    .get("/auth/figma/callback")
                    .then()
                    .statusCode(200)
            }
        }


    }
}