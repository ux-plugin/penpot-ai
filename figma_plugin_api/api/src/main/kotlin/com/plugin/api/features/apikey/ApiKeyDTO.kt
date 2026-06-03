package com.plugin.api.features.apikey

import java.time.Instant

data class CreateApiKeyRequest(val orgId: String, val name: String)

/** Plaintext returned once at creation; never persisted, never retrievable later. */
data class CreateApiKeyResponse(
    val id: String,
    val orgId: String,
    val name: String,
    val prefix: String,
    val plaintext: String,
    val createdAt: Instant,
)

data class ApiKeySummary(
    val id: String,
    val orgId: String,
    val name: String,
    val prefix: String,
    val lastUsedAt: Instant?,
    val revokedAt: Instant?,
    val createdAt: Instant,
)

data class ListApiKeysResponse(val apiKeys: List<ApiKeySummary>)
