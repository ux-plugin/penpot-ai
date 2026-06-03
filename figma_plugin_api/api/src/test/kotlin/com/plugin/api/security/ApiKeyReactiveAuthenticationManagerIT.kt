package com.plugin.api.security

import com.plugin.api.config.properties.ApiKeyProperties
import com.plugin.api.features.apikey.ApiKeyGenerator
import com.plugin.api.features.apikey.ApiKeyRepository
import com.plugin.api.features.apikey.CreateApiKeyRequest
import com.plugin.api.features.apikey.ApiKeyService
import com.plugin.api.features.organization.CreateOrganizationRequest
import com.plugin.api.features.organization.OrganizationRepository
import com.plugin.api.features.organization.OrganizationService
import com.plugin.api.testsupport.apiEnumCodec
import com.plugin.api.testsupport.insertTestUser
import com.plugin.core.testfixtures.IngestPipelineContainers
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.security.core.Authentication
import reactor.core.publisher.Mono
import reactor.test.StepVerifier
import java.util.concurrent.atomic.AtomicReference

class ApiKeyReactiveAuthenticationManagerIT {

    private val props = ApiKeyProperties(prefix = "pk_test_", redisCacheTtlSec = 60, lastUsedDebounceSec = 60)
    private val generator = ApiKeyGenerator(props)
    private lateinit var apiKeyService: ApiKeyService
    private lateinit var apiKeyRepository: ApiKeyRepository
    private lateinit var orgService: OrganizationService
    private lateinit var manager: ApiKeyReactiveAuthenticationManager

    @BeforeEach
    fun setUp() = runBlocking {
        orgService = OrganizationService(OrganizationRepository(database))
        apiKeyRepository = ApiKeyRepository(database)
        apiKeyService = ApiKeyService(apiKeyRepository, generator, orgService)
        manager = ApiKeyReactiveAuthenticationManager(apiKeyRepository, generator, redis, props)
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().block()
        suspendTransaction(database) {
            exec("TRUNCATE TABLE api_keys, organization_members, organizations, users CASCADE")
        }
    }

    @Test
    fun `valid key authenticates and the second authenticate is served from the redis cache`() = runBlocking {
        val ownerId = insertTestUser(database)
        val org = orgService.create(ownerId, CreateOrganizationRequest(name = "Auth"))
        val key = apiKeyService.create(ownerId, CreateApiKeyRequest(orgId = org.id, name = "k1"))

        val first = manager.authenticate(UnverifiedApiKeyAuthentication(key.plaintext)).block() as ApiKeyAuthentication
        assertThat(first.orgId).isEqualTo(org.id)
        assertThat(first.userId).isEqualTo(ownerId)
        assertThat(first.apiKeyId).isEqualTo(key.id)

        val cached = redis.opsForValue().get(props.redisCachePrefix + generator.hash(key.plaintext)).block()
        assertThat(cached).isNotNull
        assertThat(cached).contains(org.id, ownerId)

        val second = manager.authenticate(UnverifiedApiKeyAuthentication(key.plaintext)).block() as ApiKeyAuthentication
        assertThat(second.orgId).isEqualTo(org.id)
    }

    @Test
    fun `revoked keys are rejected with InvalidApiKeyException`() = runBlocking {
        val ownerId = insertTestUser(database)
        val org = orgService.create(ownerId, CreateOrganizationRequest(name = "Revoke"))
        val key = apiKeyService.create(ownerId, CreateApiKeyRequest(orgId = org.id, name = "k1"))
        apiKeyService.revoke(ownerId, key.id)
        // Cached entry from a previous successful auth would be a stale-grant risk; ensure cache is empty.
        redis.delete(props.redisCachePrefix + generator.hash(key.plaintext)).block()

        StepVerifier.create(manager.authenticate(UnverifiedApiKeyAuthentication(key.plaintext)))
            .expectError(InvalidApiKeyException::class.java).verify()
    }

    @Test
    fun `unknown plaintext keys are rejected with InvalidApiKeyException`() {
        StepVerifier.create(manager.authenticate(UnverifiedApiKeyAuthentication("pk_test_does_not_exist")))
            .expectError(InvalidApiKeyException::class.java).verify()
    }

    @Test
    fun `non-UnverifiedApiKeyAuthentication inputs are rejected`() {
        val authRef = AtomicReference<Authentication>(SomeOtherAuth())
        StepVerifier.create(Mono.defer { manager.authenticate(authRef.get()) })
            .expectError(InvalidApiKeyException::class.java).verify()
    }

    private class SomeOtherAuth : org.springframework.security.authentication.AbstractAuthenticationToken(emptyList()) {
        override fun getCredentials() = ""
        override fun getPrincipal() = "x"
    }

    companion object {
        private val database by lazy { IngestPipelineContainers.buildR2dbcDatabase(apiEnumCodec()) }
        private val redis by lazy { buildRedisTemplate() }

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.postgres
            IngestPipelineContainers.redis
        }

        private fun buildRedisTemplate(): ReactiveStringRedisTemplate {
            val cfg = RedisStandaloneConfiguration(IngestPipelineContainers.redisHost(), IngestPipelineContainers.redisPort())
            val factory = LettuceConnectionFactory(cfg).also { it.afterPropertiesSet() }
            return ReactiveStringRedisTemplate(factory)
        }
    }
}
