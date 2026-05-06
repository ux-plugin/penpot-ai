package com.plugin.api.config

import org.springframework.context.annotation.Configuration
import org.springframework.web.reactive.config.CorsRegistry
import org.springframework.web.reactive.config.WebFluxConfigurer

@Configuration
class WebConfig : WebFluxConfigurer {
    override fun addCorsMappings(registry: CorsRegistry) {
        registry
            .addMapping("/**")
            .allowedOrigins("*")
            .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH")
            .allowedHeaders(
                "Authorization",
                "Content-Type",
                "Accept",
                "Cache-Control",
                "Upgrade",
                "Connection",
                "Sec-WebSocket-Key",
                "Sec-WebSocket-Version",
                "Sec-WebSocket-Protocol",
                "Sec-WebSocket-Extensions",
            ).exposedHeaders("Content-Disposition")
            .maxAge(3600)
    }
}
