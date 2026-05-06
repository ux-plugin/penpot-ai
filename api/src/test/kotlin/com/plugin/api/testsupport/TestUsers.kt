package com.plugin.api.testsupport

import com.plugin.api.features.user.UserRole
import com.plugin.api.features.user.UsersTable
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import java.time.Instant
import java.util.UUID

suspend fun insertTestUser(
    database: R2dbcDatabase,
    id: String = UUID.randomUUID().toString(),
    email: String = "$id@test.local",
    name: String = "Test $id",
): String {
    suspendTransaction(database) {
        UsersTable.insert {
            it[UsersTable.id] = id
            it[UsersTable.email] = email
            it[UsersTable.name] = name
            it[UsersTable.role] = UserRole.USER
            it[UsersTable.createdAt] = Instant.now()
            it[UsersTable.allowSavingCompletions] = false
        }
    }
    return id
}
