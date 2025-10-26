package com.plugin.infrastructure.websocket

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
    private val sharedHandler: SharedWebSocketHandler,
    private val completionsFacade: CompletionsFacade,
    private val userFacade: UserFacade,
) {
    
    fun onStart(@Observes event: StartupEvent) {
        Log.info("Initializing WebSocket infrastructure...")
        
        // Register facades
        sharedHandler.registerFacade(completionsFacade)
        sharedHandler.registerFacade(userFacade)
        
        Log.info("WebSocket infrastructure initialized successfully")
    }
}
