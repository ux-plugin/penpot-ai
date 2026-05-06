package com.plugin.api.features.user
//
// import com.plugin.core.testfixtures.PostgresTestResourceManager
// import com.plugin.core.testfixtures.RedisTestResourceManager
// import io.quarkus.test.common.QuarkusTestResource
// import io.quarkus.test.junit.QuarkusTest
// import io.quarkus.test.security.TestSecurity
// import io.quarkus.test.security.jwt.Claim
// import io.quarkus.test.security.jwt.JwtSecurity
// import io.restassured.RestAssured.given
// import io.restassured.http.ContentType
// import io.smallrye.jwt.build.Jwt
// import jakarta.inject.Inject
// import java.time.Instant
// import java.util.*
// import org.hamcrest.CoreMatchers.equalTo
// import org.hibernate.reactive.mutiny.Mutiny
// import org.junit.jupiter.api.BeforeEach
// import org.junit.jupiter.api.Test
//
// @QuarkusTest
// @QuarkusTestResource(PostgresTestResourceManager::class)
// @QuarkusTestResource(RedisTestResourceManager::class)
// class UserServiceIT {
//    @Inject lateinit var sessionFactory: Mutiny.SessionFactory
//
//    @BeforeEach
//    fun cleanDatabase() {
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//            DO $$
//            BEGIN
//               IF EXISTS (SELECT FROM information_schema.tables
//                          WHERE table_schema = 'public'
//                          AND table_name = 'users') THEN
//                  EXECUTE 'TRUNCATE TABLE Users RESTART IDENTITY CASCADE';
//               END IF;
//            END $$;
//        """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//    }
//
//    // @Test
//    fun testGetUserUnauthorized() {
//        // First create a user
//        val userId = createTestUser("Test User", "testuser")
//
//        // Test without authentication
//        given().`when`().get("/user/$userId").then().statusCode(401) // Unauthorized because no
// JWT token
//    }
//
//    // @Test
//    fun testGetUserAuthorized() {
//        // Create a user with a specific username for testing
//        // We'll use the same username as the JWT subject
//        val userId = createTestUser("Test User", "test-user-id")
//
//        val token =
//            Jwt.claims()
//                .issuer("ux-plugin")
//                .claim("sub", userId)
//                .claim("role", UserRole.USER)
//                .expiresAt(Instant.now().plusSeconds(600).epochSecond)
//                .sign()
//
//        given()
//            .`when`()
//            .header("Authorization", "Bearer $token")
//            .get("/user/$userId")
//            .then()
//            .statusCode(200)
//            .body("name", equalTo("Test User"))
//            .body("username", equalTo("test-user-id"))
//    }
//
//    // @Test
//    @TestSecurity(user = "testuser", roles = [])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "wrong-user-id")])
//    fun testGetUserForbidden() {
//        // First create a user
//        val userId = createTestUser("Test User", "testuser")
//
//        // Test unauthorized access with wrong user ID in JWT
//        given().`when`().get("/user/$userId").then().statusCode(403)
//    }
//
//    // @Test
//    fun testUpdateUserUnauthorized() {
//        // First create a user
//        val userId = createTestUser("Test User", "testuser")
//
//        val updateRequest =
//            UpdateUserRequest(
//                name = "Updated Name",
//                username = null,
//                allowSavingCompletions = false,
//            )
//
//        // Test without authentication
//        given()
//            .contentType(ContentType.JSON)
//            .body(updateRequest)
//            .`when`()
//            .post("/user/$userId/update")
//            .then()
//            .statusCode(401) // Unauthorized because no JWT token
//    }
//
//    // @Test
//    fun testUpdateUserAuthorized() {
//        // Create a user with a specific username for testing
//        val userId = createTestUser("Test User", "test-user-id")
//
//        val token =
//            Jwt.claims()
//                .issuer("ux-plugin")
//                .claim("sub", userId)
//                .claim("role", UserRole.USER)
//                .expiresAt(Instant.now().plusSeconds(600).epochSecond)
//                .sign()
//
//        val updateRequest = UpdateUserRequest(name = "Updated Name", username = null,
// allowSavingCompletions = true)
//
//        // Test successful update with correct user ID
//        given()
//            .contentType(ContentType.JSON)
//            .header("Authorization", "Bearer $token")
//            .body(updateRequest)
//            .`when`()
//            .post("/user/$userId/update")
//            .then()
//            .statusCode(200)
//
//        // Verify the update was successful
//        given()
//            .`when`()
//            .header("Authorization", "Bearer $token")
//            .get("/user/$userId")
//            .then()
//            .statusCode(200)
//            .body("name", equalTo("Updated Name"))
//            .body("companionAppConnected", equalTo(true))
//            .body("companionAppPort", equalTo(8080))
//            .body("allowSavingCompletions", equalTo(true))
//    }
//
//    // @Test
//    @TestSecurity(user = "testuser", roles = [])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "wrong-user-id")])
//    fun testUpdateUserForbidden() {
//        // First, create a user
//        val userId = createTestUser("Test User", "testuser")
//
//        val updateRequest =
//            UpdateUserRequest(
//                name = "Updated Name",
//                username = null,
//                allowSavingCompletions = false,
//            )
//
//        // Test unauthorized update with wrong user ID in JWT
//        given()
//            .contentType(ContentType.JSON)
//            .body(updateRequest)
//            .`when`()
//            .post("/user/$userId/update")
//            .then()
//            .statusCode(403)
//    }
//
//    // @Test
//    fun testUserDelete() {
//        val userId = createTestUser("Test User", "testuser")
//
//        val token =
//            Jwt.claims()
//                .issuer("ux-plugin")
//                .claim("sub", userId)
//                .claim("role", UserRole.USER)
//                .expiresAt(Instant.now().plusSeconds(600).epochSecond)
//                .sign()
//
//        given().header("Authorization", "Bearer
// $token").`when`().delete("/user/$userId/delete").then().statusCode(200)
//
//        sessionFactory
//            .withTransaction { session, _ ->
//                session.createNativeQuery("SELECT COUNT(*) FROM Users",
// Long::class.java).singleResult
//            }
//            .await()
//            .indefinitely()
//            .let { count ->
//                assert(count == 0L) { "Expected 0 rows in Users table, but found $count rows. Test
// failed." }
//            }
//    }
//
//    // @Test
//    fun testUserDeleteForbidden() {
//        val userId = createTestUser("Test User", "testuser")
//        val token =
//            Jwt.claims()
//                .issuer("ux-plugin")
//                .claim("sub", "different-user-id")
//                .claim("role", UserRole.USER)
//                .expiresAt(Instant.now().plusSeconds(600).epochSecond)
//                .sign()
//        given()
//            .header("Authorization", "Bearer $token")
//            .`when`()
//            .delete("/user/right-user-id/delete")
//            .then()
//            .statusCode(403)
//    }
//
//    /** Helper method to create a test user directly in the database */
//    private fun createTestUser(name: String, username: String, id: String? = null): String {
//
//        return sessionFactory
//            .withTransaction { session, _ ->
//                // Define and execute the insertion query with RETURNING id to fetch the generated
//                // ID
//                val sql =
//                    """
//                        INSERT INTO Users (id, username, name, role, createdAt,
// allowSavingCompletions)
//                        VALUES (
//                            :id, -- Generates a UUID for the `id` column
//                            :username,         -- Replace with the provided username
//                            :name,             -- Replace with the provided name
//                            'USER',            -- Default role ('admin', 'user', 'guest')
//                            CURRENT_TIMESTAMP, -- Use the current timestamp for `createdAt`
//                            TRUE               -- Whether the user is allowed to save completions
//                        )
//                        RETURNING id;         -- Return the generated ID
//                    """
//                        .trimIndent()
//
//                session
//                    .createNativeQuery<String>(sql)
//                    .setParameter("id", id ?: UUID.randomUUID().toString())
//                    .setParameter("username", username)
//                    .setParameter("name", name)
//                    .singleResult // Fetch the resulting ID
//            }
//            .await()
//            .indefinitely()
//    }
// }
