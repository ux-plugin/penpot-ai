package com.plugin.api.features.organization

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

class OrganizationServiceIT {
    private lateinit var service: OrganizationService

    @BeforeEach
    fun setUp() = runBlocking {
        service = OrganizationService(OrganizationRepository(database))
        suspendTransaction(database) { exec("TRUNCATE TABLE organization_members, organizations, users CASCADE") }
    }

    @Test
    fun `create derives a slug from the name and assigns OWNER to the creator`() = runBlocking {
        val userId = insertTestUser(database)

        val response = service.create(userId, CreateOrganizationRequest(name = "Acme & Co!!"))

        assertThat(response.slug).isEqualTo("acme-co")
        assertThat(response.role).isEqualTo(OrgMemberRole.OWNER)
        assertThat(service.roleOf(response.id, userId)).isEqualTo(OrgMemberRole.OWNER)
    }

    @Test
    fun `create rejects a duplicate slug with OrganizationSlugTakenException`() = runBlocking {
        val a = insertTestUser(database)
        val b = insertTestUser(database)
        service.create(a, CreateOrganizationRequest(name = "Acme", slug = "acme"))

        assertThatThrownBy {
            runBlocking { service.create(b, CreateOrganizationRequest(name = "Other", slug = "acme")) }
        }.isInstanceOf(OrganizationSlugTakenException::class.java)
    }

    @Test
    fun `roleOf returns null for a user that is not a member`() = runBlocking {
        val owner = insertTestUser(database)
        val outsider = insertTestUser(database)
        val response = service.create(owner, CreateOrganizationRequest(name = "Private"))

        assertThat(service.roleOf(response.id, outsider)).isNull()
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
