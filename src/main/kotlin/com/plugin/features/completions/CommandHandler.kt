package com.plugin.features.completions

import io.quarkus.logging.Log
import io.quarkus.websockets.next.WebSocketConnection
import jakarta.enterprise.context.ApplicationScoped

/** Interface for handling WebSocket commands */
interface CommandHandler<T : WebSocketCommand> {
    /**
     * Handle a WebSocket command
     *
     * @param command The command to handle
     * @param connection The WebSocket connection
     * @param userId The user ID from the JWT token
     * @return Response message to send back to the client
     */
    suspend fun handle(command: T, connection: WebSocketConnection, userId: String): String
}

/** Handler for refresh token commands */
@ApplicationScoped
class RefreshTokenCommandHandler : CommandHandler<RefreshTokenCommand> {
    override suspend fun handle(command: RefreshTokenCommand, connection: WebSocketConnection, userId: String): String {
        Log.debug("Handling refresh_token command for user: $userId")
        // TODO: Implement token refresh logic
        return """{"status":"ok","message":"Token refresh not yet implemented"}"""
    }
}

/** Handler for completion request commands */
@ApplicationScoped
class CompletionRequestCommandHandler : CommandHandler<CompletionRequestCommand> {
    override suspend fun handle(
        command: CompletionRequestCommand,
        connection: WebSocketConnection,
        userId: String
    ): String {
        Log.info("Handling completion_request command:")
        Log.info("  FE ID: ${command.fe_id}")
        Log.info("  Timestamp: ${command.timestamp}")
        Log.info("  Drawn Path: ${command.drawn_path.take(100)}${if (command.drawn_path.length > 100) "..." else ""}")
        Log.info("  Audio Chunk Size: ${command.audio_chunk.length} base64 chars")

        // TODO: Process the completion request
        return """{"status":"ok","fe_id":"${command.fe_id}"}"""
    }
}

/** Handler for completion request end commands */
@ApplicationScoped
class CompletionRequestEndCommandHandler : CommandHandler<CompletionRequestEndCommand> {
    override suspend fun handle(
        command: CompletionRequestEndCommand,
        connection: WebSocketConnection,
        userId: String
    ): String {
        Log.info("Handling completion_request_end command for FE ID: ${command.fe_id}")
        // TODO: Finalize completion request processing
        return """{"status":"ok","fe_id":"${command.fe_id}"}"""
    }
}

/** Handler for completion response commands */
@ApplicationScoped
class CompletionResponseCommandHandler : CommandHandler<CompletionResponseCommand> {
    override suspend fun handle(
        command: CompletionResponseCommand,
        connection: WebSocketConnection,
        userId: String
    ): String {
        Log.info("Handling completion_response command:")
        Log.info("  FE ID: ${command.fe_id}")
        Log.info("  Action: ${command.action}")
        Log.info("  Target: ${command.target}")
        Log.info("  Params: ${command.params}")

        // TODO: Process the completion response
        return """{"status":"ok","fe_id":"${command.fe_id}"}"""
    }
}

/** Handler for completion response end commands */
@ApplicationScoped
class CompletionResponseEndCommandHandler : CommandHandler<CompletionResponseEndCommand> {
    override suspend fun handle(
        command: CompletionResponseEndCommand,
        connection: WebSocketConnection,
        userId: String
    ): String {
        Log.info("Handling completion_response_end command for FE ID: ${command.fe_id}")
        // TODO: Finalize completion response processing
        return """{"status":"ok","fe_id":"${command.fe_id}"}"""
    }
}

/** Command dispatcher that routes commands to appropriate handlers */
@ApplicationScoped
class CommandDispatcher(
    private val refreshTokenHandler: RefreshTokenCommandHandler,
    private val completionRequestHandler: CompletionRequestCommandHandler,
    private val completionRequestEndHandler: CompletionRequestEndCommandHandler,
    private val completionResponseHandler: CompletionResponseCommandHandler,
    private val completionResponseEndHandler: CompletionResponseEndCommandHandler,
) {
    /**
     * Dispatch a command to the appropriate handler
     *
     * @param command The command to dispatch
     * @param connection The WebSocket connection
     * @param userId The user ID from the JWT token
     * @return Response message to send back to the client
     */
    suspend fun dispatch(command: WebSocketCommand, connection: WebSocketConnection, userId: String): String {
        return when (command) {
            is RefreshTokenCommand -> refreshTokenHandler.handle(command, connection, userId)
            is CompletionRequestCommand -> completionRequestHandler.handle(command, connection, userId)
            is CompletionRequestEndCommand -> completionRequestEndHandler.handle(command, connection, userId)
            is CompletionResponseCommand -> completionResponseHandler.handle(command, connection, userId)
            is CompletionResponseEndCommand -> completionResponseEndHandler.handle(command, connection, userId)
        }
    }
}
