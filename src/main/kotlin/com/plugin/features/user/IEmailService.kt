package com.plugin.features.user

import io.smallrye.mutiny.Uni

/**
 * Interface for an email service. Defines operations related to email sending.
 */
interface IEmailService {
    /**
     * Sends email verification to the user.
     *
     * @param userId The ID of the user to verify.
     * @param username The email address of the user.
     * @param name the name of the user by which we will address him.
     * @return A `Uni<Void>` indicating the result of the email-sending operation.
     */
    fun sendEmailVerification(userId: String, username: String, name: String): Uni<Unit>

    /**
     * Sends a generic email.
     *
     * @param to The recipient email address.
     * @param subject The subject of the email.
     * @param body The body content of the email.
     * @param name the name of the user.
     * @return A `Uni<Void>` indicating the result of the email-sending operation.
     */
    fun sendEmail(to: String, subject: String, body: String, name: String): Uni<Unit>
}