//package com.plugin.features.completions
//
//import au.com.dius.pact.consumer.MockServer
//import au.com.dius.pact.consumer.dsl.PactDslWithProvider
//import au.com.dius.pact.consumer.junit5.PactConsumerTestExt
//import au.com.dius.pact.consumer.junit5.PactTestFor
//import au.com.dius.pact.core.model.V4Pact
//import au.com.dius.pact.core.model.annotations.Pact
//import com.plugin.shared.MyPostgresTestResource
//import io.quarkus.test.common.QuarkusTestResource
//import io.quarkus.test.junit.QuarkusTest
//import io.restassured.RestAssured.given
//import io.restassured.http.ContentType
//import jakarta.inject.Inject
//import org.hamcrest.CoreMatchers.containsString
//import org.hibernate.reactive.mutiny.Mutiny
//import org.junit.jupiter.api.BeforeEach
//import org.junit.jupiter.api.Test
//import org.junit.jupiter.api.extension.ExtendWith
//
///**
// * Integration test for the Component service using Quarkus testing framework
// */
//@QuarkusTest
//@QuarkusTestResource(MyPostgresTestResource::class)
//@ExtendWith(PactConsumerTestExt::class)
//@PactTestFor(providerName = "ai-server")
//class ComponentServiceIntegrationTest {
//    @Inject
//    lateinit var sessionFactory: Mutiny.SessionFactory
//
//    @BeforeEach
//    fun cleanDatabase() {
//        sessionFactory.withTransaction { session, _ ->
//            val sql = """
//            DO $$
//            BEGIN
//               IF EXISTS (SELECT FROM information_schema.tables
//                          WHERE table_schema = 'public'
//                          AND table_name = 'users') THEN
//                  EXECUTE 'TRUNCATE TABLE Users RESTART IDENTITY CASCADE';
//               END IF;
//            END $$;
//        """.trimIndent()
//
//            session.createNativeQuery<Void>(sql)
//                .executeUpdate()
//        }.await().indefinitely()
//    }
//
//    @Pact(consumer = "figma-plugin-api")
//    fun createCompletionPact(builder: PactDslWithProvider): V4Pact {
//        return builder
//            .given("AI server is available")
//            .uponReceiving("a request for completion")
//            .path("/complete")
//            .method("GET")
//            .matchQuery("prompt", ".*")
//            .willRespondWith()
//            .status(200)
//            .body(
//                """
//            {
//                "id": "test-frame-id",
//                "name": "Test Frame",
//                "width": 100,
//                "height": 100
//            }
//            """.trimIndent()
//            )
//            .toPact(V4Pact::class.java)
//    }
//
//    @Test
//    @PactTestFor(pactMethod = "createCompletionPact")
//    fun `test POST completions-create endpoint`(mockServer: MockServer) {
//        // Configure AI server to use mock server
//        val mockServerUrl = java.net.URL(mockServer.getUrl())
//        System.setProperty("engine.ai_server.host", mockServerUrl.host)
//        System.setProperty("engine.ai_server.port", mockServerUrl.port.toString())
//
//        // Test POST /completions/create endpoint
//        given()
//            .contentType(ContentType.JSON)
//            .body("""{"prompt": "test prompt", "userId": "test-user"}""")
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(200)
//            .body(containsString("test-frame-id"))
//    }
//
//    @Test
//    @PactTestFor(pactMethod = "createCompletionPact")
//    fun `test GET completions-userId endpoint`(mockServer: MockServer) {
//        // Configure AI server to use mock server
//        val mockServerUrl = java.net.URL(mockServer.getUrl())
//        System.setProperty("engine.ai_server.host", mockServerUrl.host)
//        System.setProperty("engine.ai_server.port", mockServerUrl.port.toString())
//
//        // First, save a completion
//        given()
//            .contentType(ContentType.JSON)
//            .body("""{"prompt": "test prompt", "userId": "test-user"}""")
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(200)
//
//        // Test GET /completions/{userId} endpoint
//        given()
//            .`when`()
//            .get("/completions/test-user")
//            .then()
//            .statusCode(200)
//            .body(containsString("test-user"))
//            .body(containsString("test prompt"))
//    }
//
//    @Test
//    @PactTestFor(pactMethod = "createCompletionPact")
//    fun `test GET completions-userId-completionId endpoint`(mockServer: MockServer) {
//        // Configure AI server to use mock server
//        val mockServerUrl = java.net.URL(mockServer.getUrl())
//        System.setProperty("engine.ai_server.host", mockServerUrl.host)
//        System.setProperty("engine.ai_server.port", mockServerUrl.port.toString())
//
//        // First, clean up any existing completions
//        componentRepository.deleteAllCompletions()
//
//        // Create a completion
//        given()
//            .contentType(ContentType.JSON)
//            .body("""{"prompt": "test prompt", "userId": "test-user"}""")
//            .`when`()
//            .post("/completions/create")
//            .then()
//            .statusCode(200)
//
//        // Extract the completionId from the database
//        val completions = componentRepository.getCompletions("test-user").await().indefinitely()
//        val completionId = completions[0].completionId
//
//        // Test GET /completions/{userId}/{completionId} endpoint
//        given()
//            .`when`()
//            .get("/completions/test-user/$completionId")
//            .then()
//            .statusCode(200)
//            .body(containsString("test-user"))
//            .body(containsString("test prompt"))
//            .body(containsString(completionId))
//    }
//}
