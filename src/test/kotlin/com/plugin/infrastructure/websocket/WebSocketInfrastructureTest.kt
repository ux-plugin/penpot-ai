package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.KotlinModule
import com.plugin.features.completions.CommandDispatcher
import jakarta.websocket.Session
import jakarta.websocket.RemoteEndpoint
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap

/** Simple stub implementation of Session for testing */
class TestWebSocketSession(
    private val sessionId: String = "test-session-id",
    private var sessionOpen: Boolean = true
) : Session {
    val sentMessages = mutableListOf<String>()
    
    override fun getId(): String = sessionId
    
    override fun getBasicRemote() = throw NotImplementedError()
    
    override fun getAsyncRemote(): RemoteEndpoint.Async {
        return object : RemoteEndpoint.Async {
            override fun sendText(text: String?): java.util.concurrent.Future<Void>? {
                text?.let { sentMessages.add(it) }
                return null
            }
            
            override fun sendText(text: String?, p1: jakarta.websocket.SendHandler?) {
                text?.let { sentMessages.add(it) }
            }
            
            override fun sendBinary(p0: java.nio.ByteBuffer?): java.util.concurrent.Future<Void>? = null
            override fun sendBinary(p0: java.nio.ByteBuffer?, p1: jakarta.websocket.SendHandler?) {}
            override fun sendObject(p0: Any?): java.util.concurrent.Future<Void>? = null
            override fun sendObject(p0: Any?, p1: jakarta.websocket.SendHandler?) {}
            override fun getBatchingAllowed() = false
            override fun setBatchingAllowed(p0: Boolean) {}
            override fun sendPing(p0: java.nio.ByteBuffer?) {}
            override fun sendPong(p0: java.nio.ByteBuffer?) {}
            override fun flushBatch() {}
            override fun getSendTimeout() = 0L
            override fun setSendTimeout(p0: Long) {}
        }
    }
    
    override fun close() { sessionOpen = false }
    
    override fun close(p0: jakarta.websocket.CloseReason?) { sessionOpen = false }
    
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
    
    override fun isOpen() = sessionOpen
    
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

/** Mock facade for testing */
class MockWebSocketFacade(
    private val prefix: String = "test:"
) : WebSocketFacade {
    val messagesReceived = mutableListOf<WebSocketMessage>()
    var onOpenCalled = false
    var onCloseCalled = false
    var onErrorCalled = false
    
    override fun getMessageTypePrefix(): String = prefix
    
    override suspend fun handleMessage(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse {
        messagesReceived.add(message)
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("processed" to true),
            requestId = message.requestId
        )
    }
    
    override suspend fun onOpen(session: Session, userId: String) {
        onOpenCalled = true
    }
    
    override suspend fun onClose(session: Session, userId: String) {
        onCloseCalled = true
    }
    
    override suspend fun onError(session: Session, userId: String, error: Throwable) {
        onErrorCalled = true
    }
}

/** Unit tests for WebSocket infrastructure */
class WebSocketInfrastructureTest {
    private lateinit var objectMapper: ObjectMapper
    private lateinit var mockFacade: MockWebSocketFacade
    
    @BeforeEach
    fun setup() {
        objectMapper = ObjectMapper().registerModule(KotlinModule.Builder().build())
        mockFacade = MockWebSocketFacade()
    }
    
    @Test
    fun `test WebSocketMessage serialization and deserialization`() {
        val message = WebSocketMessage(
            type = "test:action",
            payload = mapOf("key" to "value", "number" to 42),
            requestId = "req-123"
        )
        
        val json = objectMapper.writeValueAsString(message)
        val deserialized = objectMapper.readValue(json, WebSocketMessage::class.java)
        
        assertEquals(message.type, deserialized.type)
        assertEquals(message.requestId, deserialized.requestId)
        assertEquals(message.payload["key"], deserialized.payload["key"])
    }
    
    @Test
    fun `test WebSocketResponse serialization and deserialization`() {
        val response = WebSocketResponse(
            type = "test:response",
            payload = mapOf("result" to "success"),
            requestId = "req-123",
            error = null
        )
        
        val json = objectMapper.writeValueAsString(response)
        val deserialized = objectMapper.readValue(json, WebSocketResponse::class.java)
        
        assertEquals(response.type, deserialized.type)
        assertEquals(response.requestId, deserialized.requestId)
        assertEquals(response.payload["result"], deserialized.payload["result"])
    }
    
    @Test
    fun `test facade receives messages with correct prefix`() = runBlocking {
        val session = TestWebSocketSession()
        val userId = "test-user"
        
        val message = WebSocketMessage(
            type = "test:action",
            payload = mapOf("data" to "value"),
            requestId = "req-1"
        )
        
        val response = mockFacade.handleMessage(message, session, userId)
        
        assertEquals(1, mockFacade.messagesReceived.size)
        assertEquals("test:action", mockFacade.messagesReceived[0].type)
        assertEquals("req-1", response.requestId)
        assertTrue(response.payload["processed"] as Boolean)
    }
    
    @Test
    fun `test facade lifecycle methods are called`() = runBlocking {
        val session = TestWebSocketSession()
        val userId = "test-user"
        
        assertFalse(mockFacade.onOpenCalled)
        mockFacade.onOpen(session, userId)
        assertTrue(mockFacade.onOpenCalled)
        
        assertFalse(mockFacade.onCloseCalled)
        mockFacade.onClose(session, userId)
        assertTrue(mockFacade.onCloseCalled)
        
        assertFalse(mockFacade.onErrorCalled)
        mockFacade.onError(session, userId, RuntimeException("test"))
        assertTrue(mockFacade.onErrorCalled)
    }
    
    @Test
    fun `test WebSocketMessageType constants`() {
        assertEquals("completions:create", WebSocketMessageType.COMPLETIONS_CREATE)
        assertEquals("completions:refresh_token", WebSocketMessageType.COMPLETIONS_REFRESH_TOKEN)
        assertEquals("user:subscribe_ports", WebSocketMessageType.USER_SUBSCRIBE_PORTS)
        assertEquals("user:unsubscribe_ports", WebSocketMessageType.USER_UNSUBSCRIBE_PORTS)
        assertEquals("user:port_update", WebSocketMessageType.USER_PORT_UPDATE)
    }
}
