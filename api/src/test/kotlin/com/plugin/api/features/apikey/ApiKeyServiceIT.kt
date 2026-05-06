package com.plugin.api.features.apikey

import com.plugin.api.config.properties.ApiKeyProperties
import com.plugin.api.features.organization.CreateOrganizationRequest
import com.plugin.api.features.organization.OrganizationRepository
import com.plugin.api.features.organization.OrganizationService
import com.plugin.api.testsupport.apiEnumCodec
import com.plugin.api.testsupport.insertTestUser
import com.plugin.core.testfixtures.IngestPipelineContainers
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class ApiKeyServiceIT {
    private lateinit var service: ApiKeyService
    private lateinit var orgService: OrganizationService
    private lateinit var repository: ApiKeyRepository

    @BeforeEach
    fun setUp() = runBlocking {
        orgService = OrganizationService(OrganizationRepository(database))
        repository = ApiKeyRepository(database)
        val gen = ApiKeyGenerator(ApiKeyProperties(prefix = "pk_test_"))
        service = ApiKeyService(repository, gen, orgService)
        suspendTransaction(database) {
            exec("TRUNCATE TABLE api_keys, organization_members, organizations, users CASCADE")
        }
    }

    @Test
    fun `OWNER can create an api key, plaintext is returned once and the stored hash matches`() = runBlocking {
        val userId = insertTestUser(database)
        val org = orgService.create(userId, CreateOrganizationRequest(name = "Acme"))

        val response = service.create(userId, CreateApiKeyRequest(orgId = org.id, name = "default"))

        assertThat(response.plaintext).startsWith("pk_test_")
        val stored = repository.findActiveByHash(ApiKeyGenerator(ApiKeyProperties(prefix = "pk_test_")).hash(response.plaintext))
        assertThat(stored).isNotNull
        assertThat(stored!!.orgId).isEqualTo(org.id)
        assertThat(stored.createdByUserId).isEqualTo(userId)
        assertThat(stored.prefix).isEqualTo(response.prefix)
    }

    @Test
    fun `non-member is forbidden from creating an api key`() = runBlocking {
        val owner = insertTestUser(database)
        val outsider = insertTestUser(database)
        val org = orgService.create(owner, CreateOrganizationRequest(name = "Private"))

        assertThatThrownBy {
            runBlocking { service.create(outsider, CreateApiKeyRequest(orgId = org.id, name = "evil")) }
        }.isInstanceOf(ApiKeyForbiddenException::class.java)
    }

    @Test
    fun `revoked api keys do not appear in findActiveByHash and revoke is idempotent`() = runBlocking {
        val owner = insertTestUser(database)
        val org = orgService.create(owner, CreateOrganizationRequest(name = "RevokeCo"))
        val created = service.create(owner, CreateApiKeyRequest(orgId = org.id, name = "to-revoke"))
        val gen = ApiKeyGenerator(ApiKeyProperties(prefix = "pk_test_"))

        val firstRevoke = service.revoke(owner, created.id)
        assertThat(firstRevoke).isTrue

        assertThat(repository.findActiveByHash(gen.hash(created.plaintext))).isNull()

        // Second revoke is a no-op (already revoked) — service returns false.
        assertThat(service.revoke(owner, created.id)).isFalse
    }

    @Test
    fun `list returns all keys including revoked ones for org members`() = runBlocking {
        val owner = insertTestUser(database)
        val org = orgService.create(owner, CreateOrganizationRequest(name = "ListCo"))
        val a = service.create(owner, CreateApiKeyRequest(orgId = org.id, name = "a"))
        val b = service.create(owner, CreateApiKeyRequest(orgId = org.id, name = "b"))
        service.revoke(owner, a.id)

        val list = service.list(owner, org.id)
        assertThat(list.apiKeys.map { it.id }).containsExactlyInAnyOrder(a.id, b.id)
        assertThat(list.apiKeys.first { it.id == a.id }.revokedAt).isNotNull
        assertThat(list.apiKeys.first { it.id == b.id }.revokedAt).isNull()
    }

    companion object {
        private val database by lazy { IngestPipelineContainers.buildR2dbcDatabase(apiEnumCodec()) }

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.postgres
        }
    }
}
