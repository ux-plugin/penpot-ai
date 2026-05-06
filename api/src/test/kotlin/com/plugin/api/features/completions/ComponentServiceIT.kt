package com.plugin.api.features.completions
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
// import jakarta.inject.Inject
// import java.util.*
// import org.hamcrest.CoreMatchers.equalTo
// import org.hamcrest.CoreMatchers.notNullValue
// import org.hibernate.reactive.mutiny.Mutiny
// import org.junit.jupiter.api.BeforeEach
// import org.junit.jupiter.api.Test
//
// / ** Integration test for the Component service using Quarkus testing framework */
// @QuarkusTest
// @QuarkusTestResource(PostgresTestResourceManager::class)
// @QuarkusTestResource(RedisTestResourceManager::class)
// @QuarkusTestResource(MockOpenAiInfra::class)
// class ComponentServiceIT {
//    @Inject lateinit var sessionFactory: Mutiny.SessionFactory
//
//    @BeforeEach
//    fun cleanDatabase() {
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//        DO $$
//        BEGIN
//           -- Check and truncate 'ComponentCompletions'
//           IF EXISTS (SELECT FROM information_schema.tables
//                      WHERE table_schema = 'public'
//                      AND table_name = 'ComponentCompletions') THEN
//              EXECUTE 'TRUNCATE TABLE ComponentCompletions RESTART IDENTITY CASCADE';
//           END IF;
//
//           -- Check and truncate 'users'
//           IF EXISTS (SELECT FROM information_schema.tables
//                      WHERE table_schema = 'public'
//                      AND table_name = 'users') THEN
//              EXECUTE 'TRUNCATE TABLE users RESTART IDENTITY CASCADE';
//           END IF;
//        END $$;
//    """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//
//        // Create a test user
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//                        INSERT INTO users (id, name, username, role, allowSavingCompletions,
// createdAt)
//                        VALUES ('test-user-id', 'Test User', 'testuser', 'USER', true, NOW())
//                        ON CONFLICT (id) DO NOTHING;
//                    """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "test-user-id")])
//    fun testCreateCompletion() {
//        val createRequest = PromptRequest(prompt = "Test prompt")
//
//        given()
//            .contentType(ContentType.JSON)
//            .body(createRequest)
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(200)
//            .body("id", equalTo("mock-frame-id"))
//
//        given()
//            .contentType(ContentType.JSON)
//            .`when`()
//            .get("/completions")
//            .then()
//            .statusCode(200)
//            .body("size()", equalTo(1))
//            .body("[0].aiCompletion.id", equalTo("mock-frame-id"))
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "test-user-id")])
//    fun testGetCompletion() {
//        // Define variables for test data
//        val completionId = UUID.randomUUID().toString()
//        val userId = "test-user-id"
//        val prompt = "Test prompt"
//        val aiCompletionJson = """{"id":"test-frame-id","name":"Test
// Frame","width":200,"height":200}"""
//        val aiCompletionId = "test-frame-id"
//
//        // Insert the completion directly into the database
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//        INSERT INTO ComponentCompletions (id, userId, prompt, aiCompletion, createdAt)
//        VALUES ('$completionId', '$userId', '$prompt', '$aiCompletionJson', NOW())
//        """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//
//        // Test retrieving the completion by ID
//        given()
//            .`when`()
//            .get("/completions/$completionId")
//            .then()
//            .statusCode(200)
//            .body("id", equalTo(completionId))
//            .body("prompt", equalTo(prompt))
//            .body("aiCompletion.id", equalTo(aiCompletionId))
//            .body("createdAt", notNullValue())
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "test-user-id")])
//    fun testGetAllCompletions() {
//        // Extract hardcoded strings into variables
//        val userId = "test-user-id"
//        val prompt1 = "Prompt 1"
//        val prompt2 = "Prompt 2"
//        val prompt3 = "Prompt 3"
//        val frame1Json = """{"id":"frame-1","name":"Frame 1","width":100,"height":100}"""
//        val frame2Json = """{"id":"frame-2","name":"Frame 2","width":200,"height":200}"""
//        val frame3Json = """{"id":"frame-3","name":"Frame 3","width":300,"height":300}"""
//
//        // Generate UUIDs for IDs
//        val completionId1 = UUID.randomUUID().toString()
//        val completionId2 = UUID.randomUUID().toString()
//        val completionId3 = UUID.randomUUID().toString()
//
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//        INSERT INTO ComponentCompletions (id, userId, prompt, aiCompletion, createdAt)
//        VALUES
//            ('$completionId1', '$userId', '$prompt1', '$frame1Json', NOW()),
//            ('$completionId2', '$userId', '$prompt2', '$frame2Json', NOW()),
//            ('$completionId3', '$userId', '$prompt3', '$frame3Json', NOW())
//        """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//
//        // Test getting all completions
//        val response =
//            given()
//                .`when`()
//                .get("/completions/")
//                .then()
//                .statusCode(200)
//                .body("size()", equalTo(3))
//                .body("[0].id", equalTo(completionId1))
//                .body("[0].prompt", equalTo(prompt1))
//                .body("[1].id", equalTo(completionId2))
//                .body("[1].prompt", equalTo(prompt2))
//                .body("[2].id", equalTo(completionId3))
//                .body("[2].prompt", equalTo(prompt3))
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "test-user-id")])
//    fun testGetNonExistentCompletion() {
//        // Test getting a non-existent completion
//        given()
//            .`when`()
//            .get("/completions/non-existent-id")
//            .then()
//            .statusCode(404)
//            .body("message", equalTo("Completion not found"))
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "no-save-user-id")])
//    fun testCreateCompletionWithoutSavingPermission() {
//        // Create a user that doesn't allow saving completions
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//                        INSERT INTO users (id, name, username, role, allowSavingCompletions,
// createdAt)
//                        VALUES ('no-save-user-id', 'No Save User', 'nosaveuser', 'USER', false,
// NOW())
//                        ON CONFLICT (id) DO NOTHING;
//                    """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//
//        // Call the create completion endpoint
//        val createRequest = PromptRequest(prompt = "Test prompt without saving")
//
//        given()
//            .contentType(ContentType.JSON)
//            .body(createRequest)
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(200)
//            .body("id", equalTo("mock-frame-id"))
//
//        // Verify that nothing was saved in the database
//        sessionFactory
//            .withTransaction { session, _ ->
//                session
//                    .createNativeQuery<Long>(
//                        "SELECT COUNT(*) FROM ComponentCompletions WHERE userId =
// 'no-save-user-id'",
//                        Long::class.java,
//                    )
//                    .singleResult
//            }
//            .await()
//            .indefinitely()
//            .let { count ->
//                assert(count == 0L) { "Expected 0 completions for user without saving permission,
// but found $count" }
//            }
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    @JwtSecurity(claims = [Claim(key = "sub", value = "no-save-user-id")])
//    fun testUnauthorizedAccessToCompletion() {
//        // Create a completion for another user
//        val otherUserId = "other-user-id"
//        val completionId = UUID.randomUUID().toString()
//        val prompt = "Other user s prompt"
//        val aiCompletionJson = """{"id":"other-frame-id","name":"Other
// Frame","width":200,"height":200}"""
//
//        // Create the other user
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//            INSERT INTO users (id, name, username, role, allowSavingCompletions, createdAt)
//            VALUES ('$otherUserId', 'Other User', 'otheruser', 'USER', true, NOW())
//            ON CONFLICT (id) DO NOTHING;
//        """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//
//        // Insert a completion for the other user
//        sessionFactory
//            .withTransaction { session, _ ->
//                val sql =
//                    """
//            INSERT INTO ComponentCompletions (id, userId, prompt, aiCompletion, createdAt)
//            VALUES ('$completionId', '$otherUserId', '$prompt', '$aiCompletionJson', NOW())
//        """
//                        .trimIndent()
//
//                session.createNativeQuery<Void>(sql).executeUpdate()
//            }
//            .await()
//            .indefinitely()
//
//        // Test that the current user cannot access the other user's completion
//        given()
//            .`when`()
//            .get("/completions/$completionId")
//            .then()
//            .statusCode(404)
//            .body("message", equalTo("Completion not found"))
//    }
//
//    // @Test
//    fun testUnauthenticatedAccess() {
//        // Test POST /completions/create without authentication
//        given()
//            .contentType(ContentType.JSON)
//            .body(PromptRequest(prompt = "Test prompt"))
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(401)
//
//        // Test GET /completions without authentication
//        given().`when`().get("/completions").then().statusCode(401)
//
//        // Test GET /completions/{id} without authentication
//        given().`when`().get("/completions/some-id").then().statusCode(401)
//    }
//
//    // @Test
//    @TestSecurity(user = "test-user-id", roles = ["USER"])
//    fun testAiServerErrorHandling() {
//        // Create a request with a prompt that will trigger a 500 error in the mock AI server
//        // The mock server checks for exactly "500" in the prompt
//        val createRequest = PromptRequest(prompt = "500")
//
//        // Send the request and verify that a 500 error is returned
//        given()
//            .contentType(ContentType.JSON)
//            .body(createRequest)
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(500)
//
//        val createRequest2 = PromptRequest(prompt = "429")
//
//        given()
//            .contentType(ContentType.JSON)
//            .body(createRequest2)
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(500)
//    }
// }
