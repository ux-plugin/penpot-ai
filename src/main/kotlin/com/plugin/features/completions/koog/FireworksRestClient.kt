package com.plugin.features.completions.koog

import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import java.io.File
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient
import org.jboss.resteasy.reactive.PartType
import org.jboss.resteasy.reactive.RestForm

/** Request structure for Fireworks AI transcription API */
data class TranscriptionRequest(
    @field:FormParam("file") @field:PartType(MediaType.APPLICATION_OCTET_STREAM) val file: File,
    @field:FormParam("model") @field:PartType(MediaType.TEXT_PLAIN) val model: String = "whisper-v3"
)

/** Response structure from Fireworks AI transcription API */
data class FireworksTranscriptionResponse(val text: String)

/** REST client for Fireworks AI API */
@RegisterRestClient(configKey = "fireworks-api")
@Produces(MediaType.APPLICATION_JSON)
interface FireworksRestClient {

    @POST
    @Path("/v1/audio/transcriptions")
    @Consumes(MediaType.MULTIPART_FORM_DATA)
    suspend fun transcribeAudio(
        @HeaderParam("Authorization") authorization: String,
        @RestForm @PartType(MediaType.APPLICATION_OCTET_STREAM) file: File,
        @RestForm @PartType(MediaType.TEXT_PLAIN) model: String
    ): FireworksTranscriptionResponse
}
