# Logging Guide

This application uses the `tracing` crate for structured logging. This provides better observability and debugging capabilities compared to simple `println!` statements.

## Log Levels

The application supports the following log levels (in order of increasing severity):

- **TRACE**: Very detailed information, typically only for diagnosing problems
- **DEBUG**: Detailed information useful for debugging
- **INFO**: General informational messages about application progress
- **WARN**: Warning messages for potentially problematic situations
- **ERROR**: Error messages for serious problems

## Configuration

### Setting Log Level via Environment Variable

You can control the log level using the `RUST_LOG` environment variable:

```bash
# Set log level to debug
RUST_LOG=debug cargo run

# Set log level to info (default)
RUST_LOG=info cargo run

# Set log level to warn (only warnings and errors)
RUST_LOG=warn cargo run

# Set log level for specific modules
RUST_LOG=figma_plugin_companion_app::auth=debug,info cargo run
```

### Default Log Level

If `RUST_LOG` is not set, the application defaults to `info` level logging.

## Log Output Examples

### Authentication Logs

```
2024-10-31T23:00:00.000Z INFO  figma_plugin_companion_app::auth: Tracing initialized
2024-10-31T23:00:01.000Z DEBUG figma_plugin_companion_app::auth: Setting credentials
2024-10-31T23:00:01.100Z DEBUG figma_plugin_companion_app::auth: Credentials saved to keyring successfully
```

### Server Logs

```
2024-10-31T23:00:02.000Z INFO  figma_plugin_companion_app::local_server::server: Local server initialized on port 3456
2024-10-31T23:00:03.000Z DEBUG figma_plugin_companion_app::local_server::ws_handlers: New WebSocket connection established
2024-10-31T23:00:04.000Z INFO  figma_plugin_companion_app::local_server::ws_handlers: Started recording - stream stored globally
```

### Audio Manager Logs

```
2024-10-31T23:00:05.000Z DEBUG figma_plugin_companion_app::local_server::audio: Audio manager: Received start recording command
2024-10-31T23:00:05.100Z INFO  figma_plugin_companion_app::local_server::audio: Using input device: Default Microphone
2024-10-31T23:00:05.200Z INFO  figma_plugin_companion_app::local_server::audio: Audio manager: Recording started successfully
```

## Structured Logging in Code

### Using Log Levels

```rust
// Information about normal application flow
tracing::info!("Server started on port {}", port);

// Debug information for development
tracing::debug!("Processing request with id: {}", request_id);

// Warnings for potentially problematic situations
tracing::warn!("Failed to clear credentials: {}", error);

// Errors for serious problems
tracing::error!("Failed to start recording: {}", error);

// Very detailed trace information
tracing::trace!("Acquiring write lock for credentials");
```

### Using Spans for Request Tracing

Spans help track execution flow through async operations:

```rust
use tracing::info_span;

async fn logout() -> Result<(), String> {
    let span = info_span!("logout");
    let _enter = span.enter();
    
    tracing::info!("Starting logout");
    // ... logout logic ...
    tracing::info!("Logout completed");
    
    Ok(())
}
```

## Best Practices

1. **Use appropriate log levels**: 
   - Use `info` for user-visible events
   - Use `debug` for developer-relevant information
   - Use `warn` for recoverable errors
   - Use `error` for serious problems

2. **Include context in log messages**:
   ```rust
   tracing::error!("Failed to connect to server: {}", error);
   ```

3. **Use spans for tracking operations**:
   ```rust
   let span = tracing::info_span!("authentication");
   let _enter = span.enter();
   ```

4. **Avoid logging sensitive information**: Never log passwords, tokens, or other sensitive data

## Production Deployment

For production deployments, consider:

1. Setting `RUST_LOG=info` or `RUST_LOG=warn` to reduce log verbosity
2. Using log aggregation tools to collect and analyze logs
3. Setting up alerts for `ERROR` level messages
4. Rotating log files to prevent disk space issues

## Troubleshooting

If you're not seeing expected log output:

1. Check that `RUST_LOG` is set appropriately
2. Verify the tracing subscriber is initialized (should see "Tracing initialized" on startup)
3. Ensure log level is high enough to show the messages you want to see
