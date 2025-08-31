package com.plugin

import jakarta.ws.rs.ApplicationPath
import jakarta.ws.rs.core.Application
import org.eclipse.microprofile.openapi.annotations.OpenAPIDefinition
import org.eclipse.microprofile.openapi.annotations.enums.SecuritySchemeType
import org.eclipse.microprofile.openapi.annotations.info.Contact
import org.eclipse.microprofile.openapi.annotations.info.Info
import org.eclipse.microprofile.openapi.annotations.info.License
import org.eclipse.microprofile.openapi.annotations.security.SecurityScheme
import org.eclipse.microprofile.openapi.annotations.security.SecuritySchemes

/** Main application class for Quarkus. This class serves as the entry point for the JAX-RS application. */
@ApplicationPath("/")
@OpenAPIDefinition(
    info =
        Info(
            title = "Figma Plugin API",
            version = "0.0.1",
            description = "API for Figma Plugin",
            contact = Contact(name = "Support", email = "support@example.com"),
            license =
                License(
                    name = "Apache 2.0",
                    url = "https://www.apache.org/licenses/LICENSE-2.0.html",
                ),
        )
)
@SecuritySchemes(
    SecurityScheme(
        securitySchemeName = "JWT",
        type = SecuritySchemeType.HTTP,
        scheme = "bearer",
        bearerFormat = "JWT",
        description = "JWT authentication with bearer token",
    )
)
class FigmaPluginApplication : Application()
