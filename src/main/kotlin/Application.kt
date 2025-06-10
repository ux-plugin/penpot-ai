package com.plugin

import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.ApplicationPath
import jakarta.ws.rs.GET
import jakarta.ws.rs.Path
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.Application
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.eclipse.microprofile.openapi.annotations.OpenAPIDefinition
import org.eclipse.microprofile.openapi.annotations.info.Contact
import org.eclipse.microprofile.openapi.annotations.info.Info
import org.eclipse.microprofile.openapi.annotations.info.License

/**
 * Main application class for Quarkus.
 * This class serves as the entry point for the JAX-RS application.
 */
@ApplicationPath("/")
@OpenAPIDefinition(
    info = Info(
        title = "Figma Plugin API",
        version = "0.0.1",
        description = "API for Figma Plugin",
        contact = Contact(
            name = "Support",
            email = "support@example.com"
        ),
        license = License(
            name = "Apache 2.0",
            url = "https://www.apache.org/licenses/LICENSE-2.0.html"
        )
    )
)
class FigmaPluginApplication : Application()

@Path("/test")
@ApplicationScoped
class HealthResource {
    @ConfigProperty(name = "openai.api.key")
    lateinit var openaiApiKey: String

    @ConfigProperty(name = "openai.project.id")
    lateinit var openaiProjectId: String

    @ConfigProperty(name = "openai.org.id")
    lateinit var openaiOrgId: String

    @GET
    @Produces("text/plain")
    fun health(): String {
        println("openai.api.key: $openaiApiKey")
        println("openai.project.id: $openaiProjectId")
        println("openai.org.id: $openaiOrgId")
        return "OK"
    }
}

