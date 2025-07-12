package com.plugin.features.user

import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.replaceWithUnit
import jakarta.enterprise.context.ApplicationScoped
import org.eclipse.microprofile.config.inject.ConfigProperty
import java.time.Instant

@ApplicationScoped
class EmailService(
    private val userRepository: UserRepository,
    @ConfigProperty(name = "user.email-verification.code.ttl-in-s", defaultValue = "1800")
    private val verificationCodeTtlInS: Long
) : IEmailService {

    override fun sendEmailVerification(userId: String, username: String, name: String): Uni<Unit> {
        val verificationCode = generateVerificationCode()
        val expiredAt = Instant.now().plusSeconds(verificationCodeTtlInS)
        return userRepository.saveNewEmailVerificationCode(
            userId = userId,
            verificationCode = verificationCode,
            expiredAt = expiredAt
        )
            .map {
                val subject = "Verify Your Email"
                val body = buildVerificationEmailBody(verificationCode, name)

                sendEmail(username, subject, body, name)
            }.replaceWithUnit()
    }

    override fun sendEmail(to: String, subject: String, body: String, name: String): Uni<Unit> {
        // Stub for sending email (replace with actual email client logic)
        return Uni.createFrom().voidItem()
            .onItem().invoke {
                println("Email sent to: $to with subject: $subject")
            }
    }

    private fun generateVerificationCode(): String {
        // Generate a random verification code (e.g., UUID or random number)
        return (100000..999999).random().toString()
    }

    private fun buildVerificationEmailBody(code: String, name: String): String {
        return """
            Dear $name,
            
            Thank you for registering. Please verify your email address using the code below:
            
            Verification Code: $code
            
            Best regards,
            The Team
        """.trimIndent()
    }
}