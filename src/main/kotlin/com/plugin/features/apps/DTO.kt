package com.plugin.features.apps

import java.time.Instant

data class EncryptionKeyResponse(val key: String, val expiresAt: Instant)

data class AppState(val port: Int?)
