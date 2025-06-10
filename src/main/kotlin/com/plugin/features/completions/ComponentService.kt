package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.jsonSchema.JsonSchemaGenerator
import com.fasterxml.jackson.module.jsonSchema.factories.SchemaFactoryWrapper
import com.fasterxml.jackson.module.kotlin.KotlinModule
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.openapi.annotations.Operation
import org.eclipse.microprofile.openapi.annotations.media.Content
import org.eclipse.microprofile.openapi.annotations.media.Schema
import org.eclipse.microprofile.openapi.annotations.parameters.Parameter
import org.eclipse.microprofile.openapi.annotations.parameters.RequestBody
import org.eclipse.microprofile.openapi.annotations.responses.APIResponse
import org.eclipse.microprofile.openapi.annotations.responses.APIResponses

/**
 * Service class for component-related operations.
 */
@ApplicationScoped
class ComponentService @Inject constructor(
    private val componentRepository: IComponentRepository,
    private val aiServerRepository: IAiServerRepository
) : IComponentService {
    override fun getComponent(prompt: String, userId: String): Uni<FrameNode> {
        return aiServerRepository.createCompletion(prompt)
    }

    override fun saveCompletion(userId: String, prompt: String, aiCompletion: String): Uni<ComponentCompletion> {
        return componentRepository.saveCompletion(userId, prompt, aiCompletion)
    }

    override fun getCompletions(userId: String): Uni<List<ComponentCompletion>> {
        return componentRepository.getCompletions(userId)
    }

    override fun getCompletion(userId: String, completionId: String): Uni<ComponentCompletion> {
        return componentRepository.getCompletion(userId, completionId)
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
class ComponentResource @Inject constructor(
    private val componentService: IComponentService
) {
    /**
     * Create a new completion
     */
    @POST
    @Path("/create")
    @Operation(
        summary = "Create a new completion",
        description = "Creates a new component completion based on a prompt"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "Successfully created completion",
                content = [Content(schema = Schema(implementation = FrameNode::class))]
            ),
            APIResponse(responseCode = "400", description = "Bad request"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    fun createCompletion(
        @RequestBody(
            required = true,
            content = [Content(schema = Schema(implementation = PromptRequest::class))]
        )
        request: PromptRequest
    ): Uni<Response> {
        return componentService.getComponent(request.prompt, request.userId)
            .map { component -> Response.ok(component).build() }
            .onFailure().recoverWithItem { throwable ->
                throwable.printStackTrace()
                Response.status(Response.Status.INTERNAL_SERVER_ERROR)
                    .entity(mapOf("error" to throwable.message))
                    .build()
            }
    }

    /**
     * Get all completions for a user
     */
    @GET
    @Path("/{userId}")
    @Operation(
        summary = "Get all completions for a user",
        description = "Returns all completions for the specified user"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "List of completions",
                content = [Content(schema = Schema(implementation = Array<ComponentCompletion>::class))]
            ),
            APIResponse(responseCode = "400", description = "Bad request"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    fun getCompletions(
        @Parameter(
            description = "The ID of the user",
            required = true
        )
        @PathParam("userId")
        userId: String
    ): Uni<Response> {
        return componentService.getCompletions(userId)
            .map { completions -> Response.ok(completions).build() }
    }

    /**
     * Get a specific completion
     */
    @GET
    @Path("/{userId}/{completionId}")
    @Operation(
        summary = "Get a specific completion",
        description = "Returns a specific completion for the specified user"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "Completion details",
                content = [Content(schema = Schema(implementation = ComponentCompletion::class))]
            ),
            APIResponse(responseCode = "400", description = "Bad request"),
            APIResponse(responseCode = "404", description = "Completion not found"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    fun getCompletion(
        @Parameter(
            description = "The ID of the user",
            required = true
        )
        @PathParam("userId")
        userId: String,

        @Parameter(
            description = "The ID of the completion",
            required = true
        )
        @PathParam("completionId")
        completionId: String
    ): Uni<Response> {
        return componentService.getCompletion(userId, completionId)
            .map { completion -> Response.ok(completion).build() }
    }

    @GET
    @Path("/test")
    fun test(): String {
        val kotlinModule = KotlinModule.Builder().build()

        // Create an ObjectMapper and register the Kotlin module
        val objectMapper = ObjectMapper().registerModule(kotlinModule)

        // Create a custom SchemaFactoryWrapper to handle polymorphic types
        val schemaFactoryWrapper = SchemaFactoryWrapper()

        // Generate the JSON Schema
        val schemaGenerator = JsonSchemaGenerator(objectMapper)
        val schema = schemaGenerator.generateSchema(FrameNode::class.java)

        // Serialize the schema to a JSON string
        return objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(schema)
    }
}
