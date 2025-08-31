package com.plugin.features.auth

import com.plugin.features.auth.core.AuthRepository
import com.plugin.features.auth.figma.FigmaAccessScope
import com.plugin.shared.PostgresTestResourceManager
import com.plugin.shared.RedisTestResourceManager
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.quarkus.test.junit.QuarkusTestProfile
import io.quarkus.test.junit.TestProfile
import io.restassured.RestAssured.given
import io.smallrye.jwt.auth.principal.JWTParser
import io.smallrye.jwt.build.Jwt
import jakarta.inject.Inject
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.eclipse.microprofile.jwt.Claims
import org.hamcrest.CoreMatchers.containsString
import org.hamcrest.CoreMatchers.notNullValue
import org.hibernate.reactive.mutiny.Mutiny
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class FailFastFigmaAuthService : QuarkusTestProfile {
    override fun getConfigOverrides(): Map<String, String> = mapOf("auth.figma.login.timeout-sec" to "2")
}

data class User(val id: String)

/** Integration tests for the Figma login flow and related endpoints. */
@QuarkusTest
@TestProfile(FailFastFigmaAuthService::class)
@QuarkusTestResource(PostgresTestResourceManager::class, parallel = true)
@QuarkusTestResource(RedisTestResourceManager::class, parallel = true)
@QuarkusTestResource(MockFigmaAuthInfra::class, parallel = true)
class AuthServiceFigmaFlowIT {
    @Inject lateinit var sessionFactory: Mutiny.SessionFactory

    @Inject lateinit var jwtParser: JWTParser

    @Inject lateinit var authRepository: AuthRepository

    @BeforeEach
    fun cleanDatabase() {
        sessionFactory
            .withTransaction { session, _ ->
                val sql =
                    """
                        DO $$
                        BEGIN
                           IF EXISTS (SELECT FROM information_schema.tables
                                      WHERE table_schema = 'public'
                                      AND table_name = 'users') THEN
                              EXECUTE 'TRUNCATE TABLE Users RESTART IDENTITY CASCADE';
                           END IF;
                        END $$;
                    """
                        .trimIndent()
                session.createNativeQuery<Void>(sql).executeUpdate()
            }
            .await()
            .indefinitely()
    }

    @Test
    fun testFigmaLoginFlowWithCallbackFunction() {
        val response =
            given()
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

        var userId = ""

        runBlocking {
            launch(Dispatchers.IO) {
                val response =
                    given()
                        .header("Authorization", "Bearer $readTokenJwt")
                        .`when`()
                        .get("/auth/figma/access-token")
                        .then()
                        .statusCode(200)
                        .body("accessToken", notNullValue())
                        .extract()
                        .response()

                val accessToken = response.jsonPath().getString("accessToken")
                val claims = jwtParser.parse(accessToken)
                userId = claims.getClaim(Claims.sub.name)

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

        // Using sessionFactory directly since getUser is now a private method in AuthRepository
        val user =
            sessionFactory
                .withSession { session ->
                    session.find(com.plugin.features.auth.core.AuthUserEntity::class.java, userId)
                }
                .await()
                .indefinitely()

        assert(user != null) { "User ID of the token does not exist in the database." }
    }

    @Test
    fun testAccessTokenReadTimeoutWithWrongJwt() {
        given().`when`().get("/auth/figma/login").then().statusCode(200)

        given()
            .header("Authorization", "Bearer fake-jwt-token")
            .`when`()
            .get("/auth/figma/access-token")
            .then()
            .statusCode(401)
    }

    @Test
    fun testAccessTokenReadTimeoutWithJwtWithWrongReadToken() {
        val token = Jwt.claims().issuer("ux-plugin").claim("sub", "non existing read code").sign()

        given().`when`().get("/auth/figma/login").then().statusCode(200)

        given().header("Authorization", "Bearer $token").`when`().get("/auth/figma/access-token").then().statusCode(408)
    }

    @Test
    fun testFigmaLoginFlowWithCallbackFunctionWithInvalidState() {
        given().`when`().get("/auth/figma/login").then().statusCode(200)

        given()
            .queryParam("code", "test-code")
            .queryParam("state", "wrong-state")
            .`when`()
            .get("/auth/figma/callback")
            .then()
            .statusCode(400)
    }

    @Test
    fun testLoginInitiationUsingFigma() {
        given()
            .`when`()
            .get("/auth/figma/login")
            .then()
            .statusCode(200)
            .body("readTokenJwt", notNullValue())
            .body("loginUrl", containsString("https://www.figma.com/oauth"))
            .body("loginUrl", containsString("client_id="))
            .body("loginUrl", containsString("redirect_uri="))
            .body(
                "loginUrl",
                containsString("${URLEncoder.encode(FigmaAccessScope.CURRENT_USER_READ.value, "UTF-8")}"),
            )
            .body(
                "loginUrl",
                containsString("${URLEncoder.encode(FigmaAccessScope.FILE_CONTENT_READ.value, "UTF-8")}"),
            )
            .body("loginUrl", containsString("state="))
            .body("loginUrl", containsString("response_type=code"))
    }

    @Test
    fun testFigmaCallbackFunctionWithNoInitiation() {
        given()
            .queryParam("code", "test-code")
            .queryParam("state", "test-state")
            .`when`()
            .get("/auth/figma/callback")
            .then()
            .statusCode(400)
    }
}
