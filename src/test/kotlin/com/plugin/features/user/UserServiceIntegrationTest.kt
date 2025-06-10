package com.plugin.features.user

import com.plugin.shared.MyPostgresTestResource
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.restassured.RestAssured.given
import io.restassured.http.ContentType
import jakarta.inject.Inject
import org.hamcrest.CoreMatchers.containsString
import org.hibernate.reactive.mutiny.Mutiny
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Integration test for the User service using Quarkus testing framework
 */
@QuarkusTest
@QuarkusTestResource(MyPostgresTestResource::class)
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
    fun `test POST config endpoint`() {
        given()
            .contentType(ContentType.JSON)
            .body("""{"userId": "test-user", "companionAppConnected": true, "companionAppPort": 12345}""")
            .`when`()
            .post("/user/create")
            .then()
            .statusCode(201)
            .body(containsString("test-user"))
            .body(containsString("true"))
            .body(containsString("12345"))
    }

    @Test
    fun `test GET config-userId endpoint`() {
        // First, create a user config
        given()
            .contentType(ContentType.JSON)
            .body("""{"userId": "test-user", "companionAppConnected": true, "companionAppPort": 12345}""")
            .`when`()
            .post("/user/create")
            .then()
            .statusCode(201)

        // Test GET /config/{userId} endpoint
        given()
            .`when`()
            .get("/user/test-user")
            .then()
            .statusCode(200)
            .body(containsString("test-user"))
            .body(containsString("true"))
            .body(containsString("12345"))
    }

    @Test
    fun `test GET config-userId endpoint with non-existent user`() {
        // Test GET /config/{userId} endpoint with a non-existent user
        given()
            .`when`()
            .get("/user/non-existent-user")
            .then()
            .statusCode(404)
            .body(containsString("User configuration not found"))
    }

    @Test
    fun `test update existing user config`() {
        // First, create a user config
        given()
            .contentType(ContentType.JSON)
            .body("""{"userId": "test-user", "companionAppConnected": true, "companionAppPort": 12345}""")
            .`when`()
            .post("/user/create")
            .then()
            .statusCode(201)

        // Update the user config
        given()
            .contentType(ContentType.JSON)
            .body("""{"userId": "test-user", "companionAppConnected": false, "companionAppPort": 54321}""")
            .`when`()
            .post("/user/update")
            .then()
            .statusCode(200)
            .body(containsString("test-user"))
            .body(containsString("false"))
            .body(containsString("54321"))

        // Verify the updated config can be retrieved
        given()
            .`when`()
            .get("/user/test-user")
            .then()
            .statusCode(200)
            .body(containsString("test-user"))
            .body(containsString("false"))
            .body(containsString("54321"))
    }
}
