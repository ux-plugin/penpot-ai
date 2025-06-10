package com.plugin.com.plugin.features.completions

import com.plugin.features.completions.FrameNode
import com.plugin.features.completions.IAiServerRepository
import io.smallrye.mutiny.Uni
import jakarta.annotation.Priority
import jakarta.enterprise.context.ApplicationScoped
import jakarta.enterprise.inject.Alternative
import jakarta.ws.rs.GET
import jakarta.ws.rs.Path
import jakarta.ws.rs.QueryParam
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient
import org.eclipse.microprofile.rest.client.inject.RestClient

@RegisterRestClient(configKey = "ai-server-client")
interface AiServerClient {
    @GET
    @Path("/complete")
    fun createCompletion(
        @QueryParam("prompt") prompt: String,
    ): Uni<FrameNode>
}

@ApplicationScoped
@Alternative
@Priority(1)
class BamlAiServerRepository(
    @RestClient private val aiServerClient: AiServerClient
) : IAiServerRepository {
    override fun createCompletion(prompt: String): Uni<FrameNode> {
        return aiServerClient.createCompletion(prompt)
    }
}