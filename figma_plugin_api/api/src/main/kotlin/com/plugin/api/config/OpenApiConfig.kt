package com.plugin.api.config

import io.swagger.v3.oas.models.Components
import io.swagger.v3.oas.models.OpenAPI
import io.swagger.v3.oas.models.info.Contact
import io.swagger.v3.oas.models.info.Info
import io.swagger.v3.oas.models.info.License
import io.swagger.v3.oas.models.security.SecurityScheme
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration
class OpenApiConfig {
    @Bean
    fun customOpenAPI(): OpenAPI = OpenAPI()
        .info(
            Info()
                .title("Figma Plugin API")
                .version("0.0.1")
                .description("API for Figma Plugin")
                .contact(Contact().name("Support").email("support@example.com"))
                .license(License().name("Apache 2.0").url("https://www.apache.org/licenses/LICENSE-2.0.html")),
        ).components(
            Components()
                .addSecuritySchemes(
                    "JWT",
                    SecurityScheme()
                        .type(SecurityScheme.Type.HTTP)
                        .scheme("bearer")
                        .bearerFormat("JWT")
                        .description("JWT authentication with bearer token"),
                ),
        )
}
