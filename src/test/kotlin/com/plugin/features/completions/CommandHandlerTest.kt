package com.plugin.features.completions

import jakarta.websocket.Session
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** Simple stub implementation of Session for testing */
class TestSession : Session {
    override fun getId(): String = "test-session-id"

    override fun getBasicRemote() = throw NotImplementedError()

    override fun getAsyncRemote() = throw NotImplementedError()

    override fun close() {}

    override fun close(p0: jakarta.websocket.CloseReason?) {}

    override fun getContainer() = throw NotImplementedError()

    override fun addMessageHandler(p0: jakarta.websocket.MessageHandler?) = throw NotImplementedError()

    override fun <T : Any?> addMessageHandler(p0: Class<T>?, p1: jakarta.websocket.MessageHandler.Whole<T>?) =
        throw NotImplementedError()

    override fun <T : Any?> addMessageHandler(p0: Class<T>?, p1: jakarta.websocket.MessageHandler.Partial<T>?) =
        throw NotImplementedError()

    override fun getMessageHandlers() = throw NotImplementedError()

    override fun removeMessageHandler(p0: jakarta.websocket.MessageHandler?) = throw NotImplementedError()

    override fun getProtocolVersion() = throw NotImplementedError()

    override fun getNegotiatedSubprotocol() = throw NotImplementedError()

    override fun getNegotiatedExtensions() = throw NotImplementedError()

    override fun isSecure() = false

    override fun isOpen() = true

    override fun getMaxIdleTimeout() = 0L

    override fun setMaxIdleTimeout(p0: Long) {}

    override fun setMaxBinaryMessageBufferSize(p0: Int) {}

    override fun getMaxBinaryMessageBufferSize() = 0

    override fun setMaxTextMessageBufferSize(p0: Int) {}

    override fun getMaxTextMessageBufferSize() = 0

    override fun getRequestURI() = throw NotImplementedError()

    override fun getRequestParameterMap() = throw NotImplementedError()

    override fun getQueryString() = throw NotImplementedError()

    override fun getPathParameters() = throw NotImplementedError()

    override fun getUserProperties() = throw NotImplementedError()

    override fun getUserPrincipal() = throw NotImplementedError()

    override fun getOpenSessions() = throw NotImplementedError()
}

/** Unit tests for command handlers */
class CommandHandlerTest {

    @Test
    fun `test RefreshTokenCommandHandler returns ok status`() = runBlocking {
        val handler = RefreshTokenCommandHandler()
        val session = TestSession()
        val command = RefreshTokenCommand(token = "test-token")
        val userId = "test-user"

        val response = handler.handle(command, session, userId)

        assertTrue(response.contains("ok"))
    }

    @Test
    fun `test CompletionRequestCommandHandler returns ok status with fe_id`() = runBlocking {
        val handler = CompletionRequestCommandHandler()
        val session = TestSession()
        val command =
            CompletionRequestCommand(
                fe_id = "test-fe-id",
                drawn_path = "M 0 0 L 100 100",
                audio_chunk = "dGVzdA==",
                timestamp = System.currentTimeMillis(),
            )
        val userId = "test-user"

        val response = handler.handle(command, session, userId)

        assertTrue(response.contains("ok"))
        assertTrue(response.contains("test-fe-id"))
    }

    @Test
    fun `test CompletionRequestEndCommandHandler returns ok status with fe_id`() = runBlocking {
        val handler = CompletionRequestEndCommandHandler()
        val session = TestSession()
        val command = CompletionRequestEndCommand(fe_id = "test-fe-id")
        val userId = "test-user"

        val response = handler.handle(command, session, userId)

        assertTrue(response.contains("ok"))
        assertTrue(response.contains("test-fe-id"))
    }

    @Test
    fun `test CompletionResponseCommandHandler returns ok status with fe_id`() = runBlocking {
        val handler = CompletionResponseCommandHandler()
        val session = TestSession()
        val command =
            CompletionResponseCommand(
                fe_id = "test-fe-id",
                action = "create_node",
                target = "frame",
                params = """{"x": 0, "y": 0}""",
            )
        val userId = "test-user"

        val response = handler.handle(command, session, userId)

        assertTrue(response.contains("ok"))
        assertTrue(response.contains("test-fe-id"))
    }

    @Test
    fun `test CompletionResponseEndCommandHandler returns ok status with fe_id`() = runBlocking {
        val handler = CompletionResponseEndCommandHandler()
        val session = TestSession()
        val command = CompletionResponseEndCommand(fe_id = "test-fe-id")
        val userId = "test-user"

        val response = handler.handle(command, session, userId)

        assertTrue(response.contains("ok"))
        assertTrue(response.contains("test-fe-id"))
    }

    @Test
    fun `test CommandDispatcher routes RefreshTokenCommand correctly`() = runBlocking {
        val dispatcher =
            CommandDispatcher(
                RefreshTokenCommandHandler(),
                CompletionRequestCommandHandler(),
                CompletionRequestEndCommandHandler(),
                CompletionResponseCommandHandler(),
                CompletionResponseEndCommandHandler(),
            )
        val session = TestSession()
        val command = RefreshTokenCommand(token = "test-token")
        val userId = "test-user"

        val response = dispatcher.dispatch(command, session, userId)

        assertTrue(response.contains("ok"))
    }

    @Test
    fun `test CommandDispatcher routes CompletionRequestCommand correctly`() = runBlocking {
        val dispatcher =
            CommandDispatcher(
                RefreshTokenCommandHandler(),
                CompletionRequestCommandHandler(),
                CompletionRequestEndCommandHandler(),
                CompletionResponseCommandHandler(),
                CompletionResponseEndCommandHandler(),
            )
        val session = TestSession()
        val command =
            CompletionRequestCommand(
                fe_id = "dispatcher-test-id",
                drawn_path = "M 0 0 L 50 50",
                audio_chunk = "dGVzdA==",
                timestamp = System.currentTimeMillis(),
            )
        val userId = "test-user"

        val response = dispatcher.dispatch(command, session, userId)

        assertTrue(response.contains("ok"))
        assertTrue(response.contains("dispatcher-test-id"))
    }
}
