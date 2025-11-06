# Audio Recording Feature

## Overview

The WebSocket endpoint at `/completions/create` now supports receiving and recording audio data along with drawing paths. Audio chunks are accumulated during the WebSocket session and processed through an AI agent pipeline powered by Koog.

**New in this version**: Audio is now automatically transcribed using Fireworks AI's Whisper v3 Large model and processed by a Koog AI agent to generate intelligent responses. See [KOOG_PIPELINE.md](KOOG_PIPELINE.md) for details on the AI pipeline.

## Audio Format Specifications

- **Format**: PCM (Pulse Code Modulation)
- **Bit Depth**: 16-bit signed integer (I16)
- **Sample Rate**: 16000 Hz (16 kHz) - configurable in `AudioConfig`
- **Channels**: 1 (Mono)
- **Encoding**: Base64 for transmission

## How It Works

### 1. WebSocket Connection
When a client connects to `ws://localhost:8080/completions/create`:
- A new audio buffer is created for the session
- Session ID is logged

### 2. Receiving Audio Chunks
For each message received:
```json
{
  "timestamp": 1704067200000,
  "drawnPath": "M 0 0 L 100 100 Z",
  "audioChunk": "base64EncodedAudioData..."
}
```

The server:
- Decodes the base64 audio chunk
- Appends it to the session's audio buffer
- Logs the chunk size and total accumulated size

### 3. Processing Audio with AI Pipeline
When `completion_request_end` message is sent:
- All accumulated audio data is saved to a WAV file
- The audio file is transcribed using Fireworks AI Whisper v3 Large
- The transcribed text along with cursor context is processed by a Koog AI agent
- AI-generated responses are streamed back through the WebSocket connection
- See [KOOG_PIPELINE.md](KOOG_PIPELINE.md) for complete pipeline documentation

## Output Files

Audio files are saved in the `audio-recordings/` directory in the project root:
- **Location**: `./audio-recordings/`
- **Format**: `.wav` files
- **Naming**: `audio_{timestamp}_{shortSessionId}.wav`
- **Git**: Directory is ignored in `.gitignore`

## Configuration

Audio settings can be modified in `ComponentService.kt`:

```kotlin
object AudioConfig {
    const val SAMPLE_RATE = 16000 // Hz - 16kHz sample rate
    const val CHANNELS = 1        // Mono (1) or Stereo (2)
    const val BITS_PER_SAMPLE = 16 // I16 format
}
```

## Testing the Recording

### 1. Start the Server
```bash
./gradlew quarkusDev
```

### 2. Connect via WebSocket Client
```javascript
const ws = new WebSocket('ws://localhost:8080/completions/create');

ws.onopen = () => {
    console.log('Connected');
    
    // Send audio chunks
    const message = {
        timestamp: Date.now(),
        drawnPath: "M 0 0 L 100 100",
        audioChunk: base64AudioData // Your base64-encoded I16 PCM audio
    };
    
    ws.send(JSON.stringify(message));
};

ws.onmessage = (event) => {
    console.log('Server response:', event.data); // "OK" or "ERROR: ..."
};
```

### 3. Close Connection
When you close the WebSocket connection, the audio will be saved:
```javascript
ws.close();
```

### 4. Play the Recording
Check the logs for the file location, then play it with any audio player:
```bash
# Example log output:
# Audio saved to: /path/to/project/audio-recordings/audio_1704067200000_abc12345.wav

# Play with various tools:
afplay audio-recordings/audio_1704067200000_abc12345.wav  # macOS
aplay audio-recordings/audio_1704067200000_abc12345.wav   # Linux
# Or open in any audio player (VLC, Windows Media Player, etc.)
```

## Log Output Example

```
WebSocket connection opened: abc12345-6789-def0-1234-567890abcdef
Received streaming data:
  Timestamp: 1704067200000
  Drawn Path: M 0 0 L 100 100 Z
  Audio Chunk Size: 8820 bytes (decoded from 11760 base64 chars)
  Total accumulated audio: 8820 bytes
...
WebSocket connection closed: abc12345-6789-def0-1234-567890abcdef
Audio saved to: /path/to/project/audio-recordings/audio_1704067200000_abc12345.wav
Audio file size: 8864 bytes
Duration: ~0 seconds
```

## Important Notes

1. **Sample Rate Matching**: Ensure your client sends audio at the configured sample rate (16000 Hz / 16 kHz). Mismatched rates will cause playback speed issues.

2. **Base64 Encoding**: Audio chunks must be base64-encoded I16 PCM data before sending.

3. **Memory Usage**: Audio is buffered in memory during the session. For long sessions, monitor memory usage.

4. **File Cleanup**: Audio files persist indefinitely. Implement cleanup as needed for your use case.

5. **Concurrent Sessions**: Each WebSocket session has its own audio buffer, supporting multiple simultaneous recordings.

## Troubleshooting

### Audio Plays Too Fast/Slow
- Check that the client is sending audio at 16000 Hz (16 kHz)
- Verify the `AudioConfig.SAMPLE_RATE` matches your audio source

### No Audio File Created
- Check that audio chunks were actually sent (check logs for "Audio Chunk Size")
- Verify the `audio-recordings/` directory was created
- Check server logs for errors during file writing

### Audio Quality Issues
- Ensure audio is properly formatted as I16 PCM
- Verify base64 encoding is correct
- Check for data loss during transmission
