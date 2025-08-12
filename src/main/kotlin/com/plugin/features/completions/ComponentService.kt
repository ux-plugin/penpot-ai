package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.jwt.JsonWebToken

/**
 * Service class for component-related operations.
 */
@ApplicationScoped
class ComponentService @Inject constructor(
    private val componentRepository: IComponentRepository,
) : IComponentService {

    @LangChain4JServer
    private lateinit var aiServerRepositoryLangChain: IAiServerService

    override suspend fun createComponentLangChain(prompt: String, userId: String): FrameNode {
        val completion = aiServerRepositoryLangChain.createCompletion(prompt)
        saveCompletion(userId, prompt, completion)
        return completion
    }

    override suspend fun saveCompletion(userId: String, prompt: String, aiCompletion: FrameNode) {
        componentRepository.saveCompletion(userId, prompt, aiCompletion).awaitSuspending()
    }

    override suspend fun getCompletions(userId: String): List<ComponentCompletion> {
        return componentRepository.getCompletions(userId).awaitSuspending()
    }

    override suspend fun getCompletion(userId: String, completionId: String): ComponentCompletion? {
        return componentRepository.getCompletion(userId, completionId).awaitSuspending()
    }
}

/**
 * REST resource for component-related endpoints.
 * Uses CDI for dependency injection of services.
 */
@Path("/completions")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
@ApplicationScoped
@Authenticated
class ComponentResource @Inject constructor(
    private val componentService: IComponentService,
    private val jsonWebToken: JsonWebToken,
    private val objectMapper: ObjectMapper
) {
    /**
     * Create a new completion
     */
    @POST
    @Path("/create")
    suspend fun createCompletion(
        request: PromptRequest
    ): Response {
        val userId = jsonWebToken.subject
        return try {
            val component = componentService.createComponentLangChain(request.prompt, userId)
            Response.ok(component).build()
        } catch (throwable: Throwable) {
            Log.error("Failed to create completion", throwable)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR)
                .entity(CreationFailedResponse())
                .build()
        }
    }

    /**
     * Get all completions for a user
     */
    @GET
    @Path("/")
    suspend fun getCompletions(): Response {
        val userId = jsonWebToken.subject
        return try {
            val completions = componentService.getCompletions(userId)
            val response = completions.map { completion ->
                ComponentCompletionResponse(
                    id = completion.id,
                    prompt = completion.prompt,
                    aiCompletion = objectMapper.readValue(
                        completion.aiCompletion,
                        FrameNode::class.java
                    ),
                    createdAt = completion.createdAt,
                )
            }
            Response.ok(response).build()
        } catch (throwable: Throwable) {
            Log.error("Failed to load completions", throwable)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR)
                .entity(CompletionsLoadFailedResponse())
                .build()
        }
    }

    /**
     * Get a specific completion
     */
    @GET
    @Path("/{completionId}")
    suspend fun getCompletion(
        @PathParam("completionId") completionId: String
    ): Response {
        val userId = jsonWebToken.subject
        return try {
            val completion = componentService.getCompletion(userId, completionId)
            if (completion == null) {
                return Response.status(Response.Status.NOT_FOUND)
                    .entity(CompletionNotFoundResponse())
                    .build()
            }
            val response = ComponentCompletionResponse(
                id = completion.id,
                prompt = completion.prompt,
                aiCompletion = objectMapper.readValue(completion.aiCompletion, FrameNode::class.java),
                createdAt = completion.createdAt,
            )
            Response.ok(response).build()
        } catch (throwable: Throwable) {
                Log.error("Failed to get completion with ID: $completionId", throwable)
                Response.status(Response.Status.INTERNAL_SERVER_ERROR)
                    .entity(CompletionsLoadFailedResponse())
                    .build()
            }
        }
}
