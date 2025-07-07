package com.plugin.features.user

import com.plugin.shared.PostgresTestResourceManager
import com.plugin.shared.RedisTestResourceManager
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.quarkus.test.security.TestSecurity
import io.quarkus.test.security.jwt.Claim
import io.quarkus.test.security.jwt.JwtSecurity
import io.restassured.RestAssured.given
import io.restassured.http.ContentType
import io.smallrye.jwt.build.Jwt
import jakarta.inject.Inject
import org.hamcrest.CoreMatchers.equalTo
import org.hamcrest.CoreMatchers.notNullValue
import org.hibernate.reactive.mutiny.Mutiny
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Integration test for the User service using Quarkus testing framework
 */
@QuarkusTest
@QuarkusTestResource(PostgresTestResourceManager::class)
@QuarkusTestResource(RedisTestResourceManager::class)
class UserServiceIntegrationTest {
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
    fun testCreateUser() {
        val createUserRequest = CreateUserRequest(
            name = "Test User",
            username = "testuser",
            password = "password123"
        )

        // Test successful user creation
        given()
            .contentType(ContentType.JSON)
            .body(createUserRequest)
            .`when`()
            .post("/user/create")
            .then()
            .statusCode(201)
            .body("id", notNullValue())

        // Test duplicate user creation (should fail)
        given()
            .contentType(ContentType.JSON)
            .body(createUserRequest)
            .`when`()
            .post("/user/create")
            .then()
            .statusCode(409)
    }

    @Test
    fun testGetUserUnauthorized() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        // Test without authentication
        given()
            .`when`()
            .get("/user/$userId")
            .then()
            .statusCode(401) // Unauthorized because no JWT token
    }

    @Test
    fun testGetUserAuthorized() {
        // Create a user with a specific username for testing
        // We'll use the same username as the JWT subject
        val userId = createTestUser("Test User", "test-user-id", "password123")

        val token = Jwt.claims()
            .issuer("ux-plugin")
            .claim("sub", userId)
            .claim("role", UserRoles.USER.value)
            .expiresAt(System.currentTimeMillis() + 600000)
            .sign()

        given()
            .`when`()
            .header("Authorization", "Bearer $token")
            .get(
                "/user/$userId"
            )
            .then()
            .statusCode(200)
            .body("name", equalTo("Test User"))
            .body("username", equalTo("test-user-id"))
    }

    @Test
    @TestSecurity(user = "testuser", roles = [])
    @JwtSecurity(
        claims = [
            Claim(key = "sub", value = "wrong-user-id")
        ]
    )
    fun testGetUserForbidden() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        // Test unauthorized access with wrong user ID in JWT
        given()
            .`when`()
            .get("/user/$userId")
            .then()
            .statusCode(403)
    }

    @Test
    fun testUpdateUserUnauthorized() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        val updateRequest = UpdateUserRequest(
            name = "Updated Name",
            username = null,
            password = null,
            companionAppConnected = true,
            companionAppPort = 8080
        )

        // Test without authentication
        given()
            .contentType(ContentType.JSON)
            .body(updateRequest)
            .`when`()
            .post("/user/$userId/update")
            .then()
            .statusCode(401) // Unauthorized because no JWT token
    }

    @Test
    fun testUpdateUserAuthorized() {
        // Create a user with a specific username for testing
        val userId = createTestUser("Test User", "test-user-id", "password123")

        val token = Jwt.claims()
            .issuer("ux-plugin")
            .claim("sub", userId)
            .claim("role", UserRoles.USER.value)
            .expiresAt(System.currentTimeMillis() + 600000)
            .sign()

        val updateRequest = UpdateUserRequest(
            name = "Updated Name",
            username = null,
            password = null,
            companionAppConnected = true,
            companionAppPort = 8080
        )

        // Test successful update with correct user ID
        given()
            .contentType(ContentType.JSON)
            .header("Authorization", "Bearer $token")
            .body(updateRequest)
            .`when`()
            .post("/user/$userId/update")
            .then()
            .statusCode(200)

        // Verify the update was successful
        given()
            .`when`()
            .header("Authorization", "Bearer $token")
            .get("/user/$userId")
            .then()
            .statusCode(200)
            .body("name", equalTo("Updated Name"))
            .body("companionAppConnected", equalTo(true))
            .body("companionAppPort", equalTo(8080))
    }

    @Test
    @TestSecurity(user = "testuser", roles = [])
    @JwtSecurity(
        claims = [
            Claim(key = "sub", value = "wrong-user-id")
        ]
    )
    fun testUpdateUserForbidden() {
        // First create a user
        val userId = createTestUser("Test User", "testuser", "password123")

        val updateRequest = UpdateUserRequest(
            name = "Updated Name",
            username = null,
            password = null,
            companionAppConnected = true,
            companionAppPort = 8080
        )

        // Test unauthorized update with wrong user ID in JWT
        given()
            .contentType(ContentType.JSON)
            .body(updateRequest)
            .`when`()
            .post("/user/$userId/update")
            .then()
            .statusCode(403)
    }

    /**
     * Helper method to create a test user directly in the database
     */
    private fun createTestUser(name: String, username: String, password: String): String {
        val createUserRequest = CreateUserRequest(
            name = name,
            username = username,
            password = password
        )

        return given()
            .contentType(ContentType.JSON)
            .body(createUserRequest)
            .`when`()
            .post("/user/create")
            .then()
            .statusCode(201)
            .extract()
            .path("id")
    }

}
