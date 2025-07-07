package com.plugin.features.user

/**
 * Domain model for a user
 */
data class User(
    var id: String = "",
    var name: String = "",
    var username: String = "",
    var password: String = "",
    var companionAppConnected: Boolean = false,
    var companionAppPort: Int = 64032
)
