package com.plugin.infrastructure.websocket

import com.plugin.features.auth.core.AuthMessageHandler
import com.plugin.features.completions.CompletionsMessageHandler
import com.plugin.features.user.UserMessageHandler
import io.quarkus.logging.Log
import io.quarkus.runtime.StartupEvent
import jakarta.enterprise.context.ApplicationScoped
import jakarta.enterprise.event.Observes
import jakarta.inject.Inject

/**
 * Configuration class for WebSocket infrastructure
 *
 * Registers all facades with the shared WebSocket handler on application startup
 */
@ApplicationScoped
class WebSocketConfiguration
@Inject
constructor(
    private val sharedHandler: SharedWebSocketRouter,
    private val authMessageHandler: AuthMessageHandler,
    private val completionsFacade: CompletionsMessageHandler,
    private val userFacade: UserMessageHandler,
) {

    fun onStart(@Observes event: StartupEvent) {
        Log.info("Initializing WebSocket infrastructure...")

        // Register facades (auth first for proper message routing)
        sharedHandler.registerMessageHandler(authMessageHandler)
        sharedHandler.registerMessageHandler(completionsFacade)
        sharedHandler.registerMessageHandler(userFacade)

        Log.info("WebSocket infrastructure initialized successfully")
    }
}
