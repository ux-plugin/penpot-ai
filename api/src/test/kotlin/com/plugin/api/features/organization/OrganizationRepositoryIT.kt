package com.plugin.api.features.organization

import com.plugin.api.testsupport.apiEnumCodec
import com.plugin.api.testsupport.insertTestUser
import com.plugin.core.testfixtures.IngestPipelineContainers
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.time.Instant
import java.util.UUID

class OrganizationRepositoryIT {
    private lateinit var repository: OrganizationRepository

    @BeforeEach
    fun setUp() = runBlocking {
        repository = OrganizationRepository(database)
        suspendTransaction(database) { exec("TRUNCATE TABLE organization_members, organizations, users CASCADE") }
    }

    @Test
    fun `create persists the org and an OWNER membership for the creator`() = runBlocking {
        val userId = insertTestUser(database)
        val org = OrganizationEntity(slug = "acme-${UUID.randomUUID().toString().take(6)}", name = "Acme", createdAt = Instant.now())

        repository.create(org, userId)

        val saved = repository.findById(org.id)
        assertThat(saved).isNotNull
        assertThat(saved!!.slug).isEqualTo(org.slug)

        val membership = repository.findMembership(org.id, userId)
        assertThat(membership).isNotNull
        assertThat(membership!!.role).isEqualTo(OrgMemberRole.OWNER)
    }

    @Test
    fun `listForUser returns only orgs the user is a member of`() = runBlocking {
        val alice = insertTestUser(database)
        val bob = insertTestUser(database)

        val aliceOrg = OrganizationEntity(slug = "alice-org", name = "AliceCo")
        val bobOrg = OrganizationEntity(slug = "bob-org", name = "BobCo")
        repository.create(aliceOrg, alice)
        repository.create(bobOrg, bob)

        val aliceList = repository.listForUser(alice)
        assertThat(aliceList).hasSize(1)
        assertThat(aliceList.first().first.id).isEqualTo(aliceOrg.id)
        assertThat(aliceList.first().second).isEqualTo(OrgMemberRole.OWNER)

        val bobList = repository.listForUser(bob)
        assertThat(bobList).hasSize(1)
        assertThat(bobList.first().first.id).isEqualTo(bobOrg.id)
    }

    @Test
    fun `findBySlug looks up by case-sensitive slug`() = runBlocking {
        val userId = insertTestUser(database)
        val org = OrganizationEntity(slug = "acme-corp", name = "Acme")
        repository.create(org, userId)

        assertThat(repository.findBySlug("acme-corp")).isNotNull
        assertThat(repository.findBySlug("missing")).isNull()
    }

    @Test
    fun `findMembership returns null when the user is not in the org`() = runBlocking {
        val owner = insertTestUser(database)
        val outsider = insertTestUser(database)
        val org = OrganizationEntity(slug = "private-${UUID.randomUUID().toString().take(6)}", name = "Private")
        repository.create(org, owner)

        assertThat(repository.findMembership(org.id, outsider)).isNull()
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
