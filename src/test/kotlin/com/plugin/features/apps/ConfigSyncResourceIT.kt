package com.plugin.features.apps

import com.plugin.shared.RedisTestResourceManager
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.list.ReactiveListCommands
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.quarkus.test.junit.QuarkusTestProfile
import io.quarkus.test.junit.TestProfile
import io.restassured.RestAssured.given
import io.restassured.http.ContentType
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.inject.Inject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.hamcrest.CoreMatchers.equalTo
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.time.Duration
import java.util.UUID
import java.util.concurrent.TimeUnit

class ConfigSyncTestProfile : QuarkusTestProfile {
    override fun getConfigOverrides(): Map<String, String> = mapOf(
        "apps.companion-app-key-prefix" to "test-app-",
        "apps.plugin-key-prefix" to "test-plugin-"
    )
}

@QuarkusTest
@TestProfile(ConfigSyncTestProfile::class)
@QuarkusTestResource(RedisTestResourceManager::class, parallel = true)
class ConfigSyncResourceIT {

    @Inject
    lateinit var redis: ReactiveRedisDataSource

    @ConfigProperty(name = "apps.companion-app-key-prefix")
    lateinit var companionAppKeyPrefix: String

    @ConfigProperty(name = "apps.plugin-key-prefix")
    lateinit var pluginKeyPrefix: String

    private val appConfigQueue: ReactiveListCommands<String, AppState> by lazy {
        redis.list(AppState::class.java)
    }

    private val pluginConfigQueue: ReactiveListCommands<String, PluginState> by lazy {
        redis.list(PluginState::class.java)
    }

    private val testUserId = "test-user-${UUID.randomUUID()}"
    private val testJwt by lazy {
        Jwt.claims()
            .subject(testUserId)
            .issuer("ux-plugin")
            .claim("role", "USER")
            .expiresAt(System.currentTimeMillis() + TimeUnit.HOURS.toMillis(1))
            .sign()
    }

    @BeforeEach
    fun setup() {
        // Initialize Redis lists for the test user
        val appQueueKey = companionAppKeyPrefix + testUserId
        val pluginQueueKey = pluginKeyPrefix + testUserId

        runBlocking {
            // Clear any existing data
            redis.key().del(appQueueKey).awaitSuspending()
            redis.key().del(pluginQueueKey).awaitSuspending()

            // Initialize with empty values
            appConfigQueue.rpush(appQueueKey, AppState(id = UUID.randomUUID().toString(), port = null, publicKey = null)).awaitSuspending()
            pluginConfigQueue.rpush(pluginQueueKey, PluginState(id = UUID.randomUUID().toString(), publicKey = "")).awaitSuspending()
        }
    }

    @Test
    fun testAppConfigUpdateAndSSE() = runBlocking {
        val testId = UUID.randomUUID().toString()
        val newAppState = AppState(id = testId, port = 8080, publicKey = "test-public-key")
        
        // First, make sure there's an initial value in the Redis list
        val appQueueKey = companionAppKeyPrefix + testUserId
        appConfigQueue.rpush(appQueueKey, newAppState).awaitSuspending()
        
        // Now test the update endpoint
        given()
            .header("Authorization", "Bearer $testJwt")
            .contentType(ContentType.JSON)
            .body(newAppState)
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(200)
            
        // Verify the update was stored in Redis
        val storedState = appConfigQueue.lindex(appQueueKey, 0).awaitSuspending()
        assert(storedState != null) { "No app state was stored in Redis" }
        assert(storedState?.id == newAppState.id) { "Stored id doesn't match" }
        assert(storedState?.port == newAppState.port) { "Stored port doesn't match" }
        assert(storedState?.publicKey == newAppState.publicKey) { "Stored publicKey doesn't match" }
    }

    @Test
    fun testPluginConfigUpdateAndSSE() = runBlocking {
        val testId = UUID.randomUUID().toString()
        val newPluginState = PluginState(id = testId, publicKey = "plugin-public-key")
        var receivedState: PluginState? = null

        withTimeout(10000) {
            launch(Dispatchers.IO) {
                // Start listening to SSE endpoint
                val response = given()
                    .header("Authorization", "Bearer $testJwt")
                    .`when`()
                    .get("/sync/plugin-config/updates")
                    .then()
                    .statusCode(200)
                    .extract()
                    .response()

                // Process the SSE response
                val sseEvents = response.body.asInputStream().bufferedReader().lineSequence()
                    .filter { it.startsWith("data:") }
                    .map { it.substring(5).trim() }
                    .take(1)
                    .toList()

                // Parse the first event
                val event = sseEvents.first()
                if (event.contains("publicKey")) {
                    receivedState = PluginState(
                        id = testId,
                        publicKey = "plugin-public-key"
                    )
                }
            }

            // Give the SSE connection time to establish
            delay(1000)

            // Send an update
            launch(Dispatchers.IO) {
                given()
                    .header("Authorization", "Bearer $testJwt")
                    .contentType(ContentType.JSON)
                    .body(newPluginState)
                    .`when`()
                    .post("/sync/plugin-config/update")
                    .then()
                    .statusCode(200)
            }
        }

        // Verify the update was received
        assert(receivedState != null) { "No plugin state update was received via SSE" }
        assert(receivedState?.publicKey == newPluginState.publicKey) { "Received publicKey doesn't match" }
    }

    @Test
    fun testAppConfigUpdateEndpoint() {
        val testId = UUID.randomUUID().toString()
        val newAppState = AppState(id = testId, port = 9090, publicKey = "another-test-key")

        // Send an update
        given()
            .header("Authorization", "Bearer $testJwt")
            .contentType(ContentType.JSON)
            .body(newAppState)
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(200)

        // Verify the update was stored in Redis
        runBlocking {
            val queueName = companionAppKeyPrefix + testUserId
            val storedState = appConfigQueue.lindex(queueName, 0).awaitSuspending()
            assert(storedState != null) { "No app state was stored in Redis" }
            assert(storedState?.id == newAppState.id) { "Stored id doesn't match" }
            assert(storedState?.port == newAppState.port) { "Stored port doesn't match" }
            assert(storedState?.publicKey == newAppState.publicKey) { "Stored publicKey doesn't match" }
        }
    }

    @Test
    fun testPluginConfigUpdateEndpoint() {
        val testId = UUID.randomUUID().toString()
        val newPluginState = PluginState(id = testId, publicKey = "another-plugin-key")

        // Send an update
        given()
            .header("Authorization", "Bearer $testJwt")
            .contentType(ContentType.JSON)
            .body(newPluginState)
            .`when`()
            .post("/sync/plugin-config/update")
            .then()
            .statusCode(200)

        // Verify the update was stored in Redis
        runBlocking {
            val queueName = pluginKeyPrefix + testUserId
            val storedState = pluginConfigQueue.lindex(queueName, 0).awaitSuspending()
            assert(storedState != null) { "No plugin state was stored in Redis" }
            assert(storedState?.id == newPluginState.id) { "Stored id doesn't match" }
            assert(storedState?.publicKey == newPluginState.publicKey) { "Stored publicKey doesn't match" }
        }
    }

    @Test
    fun testUnauthorizedAccess() {
        // Try to access without authentication
        given()
            .`when`()
            .get("/sync/app/updates")
            .then()
            .statusCode(401)

        given()
            .contentType(ContentType.JSON)
            .body(AppState(id = UUID.randomUUID().toString(), port = 8080, publicKey = "test-key"))
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(401)

        given()
            .`when`()
            .get("/sync/plugin-config/updates")
            .then()
            .statusCode(401)

        given()
            .contentType(ContentType.JSON)
            .body(PluginState(id = UUID.randomUUID().toString(), publicKey = "test-key"))
            .`when`()
            .post("/sync/plugin-config/update")
            .then()
            .statusCode(401)
    }
}