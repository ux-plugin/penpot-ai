package com.plugin.core.replay

import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction

// Not @Repository / @Component on purpose: the sanitizer + anonymizer apps scan
// `com.plugin.core` but have no R2dbcDatabase bean. Each app that actually needs
// it (api, processor) wires this manually as a @Bean.
class SessionMetadataRepository(private val database: R2dbcDatabase) {

    suspend fun upsert(meta: SessionMetadata): SessionMetadata = suspendTransaction(database) {
        // Idempotent re-delivery from the anonymizer is expected; replace rather than fail.
        SessionMetadataTable.deleteWhere { sessionId eq meta.sessionId }
        SessionMetadataTable.insert {
            it[sessionId] = meta.sessionId
            it[orgId] = meta.orgId
            it[firstSeq] = meta.firstSeq
            it[lastSeq] = meta.lastSeq
            it[chunkCount] = meta.chunkCount
            it[eventCount] = meta.eventCount
            it[durationMs] = meta.durationMs
            it[pageTransitions] = meta.pageTransitions
            it[firstEventAt] = meta.firstEventAt
            it[lastEventAt] = meta.lastEventAt
            it[processedAt] = meta.processedAt
        }
        meta
    }

    suspend fun findById(sessionId: String): SessionMetadata? = suspendTransaction(database) {
        SessionMetadataTable.selectAll().where { SessionMetadataTable.sessionId eq sessionId }
            .map { it.toEntity() }.firstOrNull()
    }

    suspend fun listByOrg(orgId: String, limit: Int = 100): List<SessionMetadata> = suspendTransaction(database) {
        SessionMetadataTable.selectAll()
            .where { SessionMetadataTable.orgId eq orgId }
            .orderBy(SessionMetadataTable.processedAt, SortOrder.DESC)
            .limit(limit)
            .map { it.toEntity() }
            .toList()
    }

    private fun ResultRow.toEntity() = SessionMetadata(
        sessionId = this[SessionMetadataTable.sessionId],
        orgId = this[SessionMetadataTable.orgId],
        firstSeq = this[SessionMetadataTable.firstSeq],
        lastSeq = this[SessionMetadataTable.lastSeq],
        chunkCount = this[SessionMetadataTable.chunkCount],
        eventCount = this[SessionMetadataTable.eventCount],
        durationMs = this[SessionMetadataTable.durationMs],
        pageTransitions = this[SessionMetadataTable.pageTransitions],
        firstEventAt = this[SessionMetadataTable.firstEventAt],
        lastEventAt = this[SessionMetadataTable.lastEventAt],
        processedAt = this[SessionMetadataTable.processedAt],
    )
}
