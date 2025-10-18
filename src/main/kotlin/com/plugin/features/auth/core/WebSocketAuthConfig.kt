package com.plugin.features.auth.core

import io.smallrye.config.ConfigMapping
import jakarta.validation.constraints.NotBlank

/** Configuration for WebSocket authentication */
@ConfigMapping(prefix = "websocket.auth")
interface WebSocketAuthConfig {

    /** The WebSocket path that requires query parameter authentication */
    @NotBlank fun path(): String

    /** The name of the query parameter containing the JWT token */
    @NotBlank fun tokenQueryParam(): String

    /** The name of the HTTP header used for WebSocket upgrade */
    @NotBlank fun upgradeHeader(): String

    /** The expected value of the upgrade header for WebSocket connections */
    @NotBlank fun websocketValue(): String
}
