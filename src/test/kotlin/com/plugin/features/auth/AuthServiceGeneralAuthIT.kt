package com.plugin.features.auth

import com.plugin.shared.PostgresTestResourceManager
import com.plugin.shared.RedisTestResourceManager
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.restassured.RestAssured.given
import jakarta.inject.Inject
import org.hibernate.reactive.mutiny.Mutiny
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Integration tests for general (non-Figma) authentication endpoints.
 */
@QuarkusTest
@QuarkusTestResource(PostgresTestResourceManager::class, parallel = true)
@QuarkusTestResource(RedisTestResourceManager::class, parallel = true)
class AuthServiceGeneralAuthIT {
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
            session.createNativeQuery<Void>(sql).executeUpdate()
        }.await().indefinitely()
    }

    @Test
    fun testRefreshTokenWithInvalidToken() {
        val userId = createTestUser("Test User", "testuser")

        given()
            .cookie("refresh_token", "invalid-token")
            .queryParam("userId", userId)
            .`when`()
            .post("/auth/access-token/refresh")
            .then()
            .statusCode(401)
    }

    @Test
    fun testRefreshTokenWithMissingToken() {
        val userId = createTestUser("Test User", "testuser")

        given()
            .queryParam("userId", userId)
            .`when`()
            .post("/auth/access-token/refresh")
            .then()
            .statusCode(401)
    }

    /**
     * Helper method to create a test user directly in the database using SQL.
     */
    private fun createTestUser(name: String, username: String): String {
        val userId = java.util.UUID.randomUUID().toString()
        val result = sessionFactory.withTransaction { session, _ ->
            val sql = """
                INSERT INTO Users (id, username, name, role, companionAppConnected, companionAppPort, createdAt)
                VALUES ('$userId', '$username', '$name', 'USER', false, 64032, CURRENT_TIMESTAMP)
            """.trimIndent()

            session.createNativeQuery<Void>(sql)
                .executeUpdate()
                .replaceWith(userId)
        }.await().indefinitely()

        return result
    }
}