package com.plugin.features.auth

import com.plugin.features.user.CreateUserRequest
import com.plugin.shared.PostgresTestResourceManager
import com.plugin.shared.RedisTestResourceManager
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.restassured.RestAssured.given
import io.restassured.http.ContentType
import jakarta.inject.Inject
import org.hamcrest.CoreMatchers.notNullValue
import org.hibernate.reactive.mutiny.Mutiny
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Integration test for the Auth service using Quarkus testing framework
 */
@QuarkusTest
@QuarkusTestResource(PostgresTestResourceManager::class)
@QuarkusTestResource(RedisTestResourceManager::class)
class AuthServiceIntegrationTest {
    @Inject
    lateinit var sessionFactory: Mutiny.SessionFactory

    @BeforeEach
    fun cleanDatabase() {
        sessionFactory.withTransaction { session, _ ->
            val sql = """
            DO $$ 
            BEGIN 
               IF EXISTS (SELECT FROM information_schema.tables 
                          WHERE table_schema = 'public' 
                          AND table_name = 'users') THEN
                  EXECUTE 'TRUNCATE TABLE Users RESTART IDENTITY CASCADE';
               END IF;
            END $$;
        """.trimIndent()

            session.createNativeQuery<Void>(sql)
                .executeUpdate()
        }.await().indefinitely()
    }

    @Test
    fun testSuccessfulLogin() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        // Test successful login
        val loginRequest = LoginRequest(
            username = "testuser",
            password = "password123"
        )

        given()
            .contentType(ContentType.JSON)
            .body(loginRequest)
            .`when`()
            .post("/auth/login")
            .then()
            .statusCode(200)
            .body("accessToken", notNullValue())
            .cookie("refresh_token", notNullValue())
    }

    @Test
    fun testFailedLoginWithWrongPassword() {
        // First create a user
        createTestUser("Test User", "testuser", "password123")

        // Test login with wrong password
        val loginRequest = LoginRequest(
            username = "testuser",
            password = "wrongpassword"
        )

        given()
            .contentType(ContentType.JSON)
            .body(loginRequest)
            .`when`()
            .post("/auth/login")
            .then()
            .statusCode(401)
    }

    @Test
    fun testFailedLoginWithNonExistentUser() {
        // Test login with non-existent user
        val loginRequest = LoginRequest(
            username = "nonexistentuser",
            password = "password123"
        )

        given()
            .contentType(ContentType.JSON)
            .body(loginRequest)
            .`when`()
            .post("/auth/login")
            .then()
            .statusCode(401)
    }

    @Test
    fun testMultipleLoginsReturnSameTokens() {
        // First create a user
        createTestUser("Test User", "testuser", "password123")

        // Login first time
        val loginRequest = LoginRequest(
            username = "testuser",
            password = "password123"
        )

        val firstResponse = given()
            .contentType(ContentType.JSON)
            .body(loginRequest)
            .`when`()
            .post("/auth/login")
            .then()
            .statusCode(200)
            .extract()

        val firstAccessToken = firstResponse.path<String>("accessToken")
        val firstRefreshToken = firstResponse.cookie("refresh_token")

        // Login second time
        val secondResponse = given()
            .contentType(ContentType.JSON)
            .body(loginRequest)
            .`when`()
            .post("/auth/login")
            .then()
            .statusCode(200)
            .extract()

        val secondAccessToken = secondResponse.path<String>("accessToken")
        val secondRefreshToken = secondResponse.cookie("refresh_token")

        // Verify tokens are the same
        assert(firstAccessToken == secondAccessToken) { "Access tokens should be the same for multiple logins" }
        assert(firstRefreshToken == secondRefreshToken) { "Refresh tokens should be the same for multiple logins" }
    }

    @Test
    fun testRefreshTokenWithInvalidToken() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        // Test refresh token with invalid token
        given()
            .cookie("refresh_token", "invalid-token")
            .queryParam("userId", userId)
            .`when`()
            .post("/auth/refresh-token")
            .then()
            .statusCode(401)
    }

    @Test
    fun testRefreshTokenWithMissingToken() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        // Test refresh token with missing token
        given()
            .queryParam("userId", userId)
            .`when`()
            .post("/auth/refresh-token")
            .then()
            .statusCode(401)
    }

    @Test
    fun testMultipleRefreshTokenCallsReturnSameAccessToken() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        // Login to get refresh token
        val loginRequest = LoginRequest(
            username = "testuser",
            password = "password123"
        )

        val loginResponse = given()
            .contentType(ContentType.JSON)
            .body(loginRequest)
            .`when`()
            .post("/auth/login")
            .then()
            .statusCode(200)
            .extract()

        val refreshToken = loginResponse.cookie("refresh_token")

        // First refresh token call
        val firstRefreshResponse = given()
            .cookie("refresh_token", refreshToken)
            .queryParam("userId", userId)
            .`when`()
            .post("/auth/refresh-token")
            .then()
            .statusCode(200)
            .extract()

        val firstAccessToken = firstRefreshResponse.path<String>("accessToken")

        // Second refresh token call
        val secondRefreshResponse = given()
            .cookie("refresh_token", refreshToken)
            .queryParam("userId", userId)
            .`when`()
            .post("/auth/refresh-token")
            .then()
            .statusCode(200)
            .extract()

        val secondAccessToken = secondRefreshResponse.path<String>("accessToken")

        // Verify access tokens are the same
        assert(firstAccessToken == secondAccessToken) { "Access tokens should be the same for multiple refresh token calls" }
    }

    /**
     * Helper method to create a test user directly in the database using SQL
     */
    private fun createTestUser(name: String, username: String, password: String): String {
        // Generate a UUID for the user ID
        val userId = java.util.UUID.randomUUID().toString()

        // Create and execute SQL insert statement
        val result = sessionFactory.withTransaction { session, _ ->
            val sql = """
                INSERT INTO Users (id, username, password, name, role, companionAppConnected, companionAppPort, createdAt)
                VALUES ('$userId', '$username', '$password', '$name', 'USER', false, 64032, CURRENT_TIMESTAMP)
            """.trimIndent()

            session.createNativeQuery<Void>(sql)
                .executeUpdate()
                .replaceWith(userId)
        }.await().indefinitely()

        return result
    }
}
