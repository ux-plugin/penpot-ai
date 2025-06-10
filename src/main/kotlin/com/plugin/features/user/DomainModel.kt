package com.plugin.features.user

/**
 * Domain model for a user
 */
data class User(
    var userId: String = "",
    var companionAppConnected: Boolean = false,
    var companionAppPort: Int = 64032
)
