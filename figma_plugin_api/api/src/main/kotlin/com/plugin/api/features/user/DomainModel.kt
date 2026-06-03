package com.plugin.api.features.user

data class EmailVerificationCode(val userId: String, val verificationCode: String, var failedAttempts: Int = 0)
