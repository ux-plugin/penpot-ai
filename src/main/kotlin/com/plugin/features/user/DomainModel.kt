package com.plugin.features.user

data class EmailVerificationCode(
    val userId: String,
    val verificationCode: String,
    var failedAttempts: Int = 0,
)
