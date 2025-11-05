# Audio Agent Pipeline with LangChain4j

## Overview

This implementation provides a complete audio processing pipeline using LangChain4j (Kotlin) that transcribes recorded audio using Fireworks AI's Whisper v3 Large model and generates AI responses through an agent system.

## Architecture

### Pipeline Components

The system is built on a modular pipeline architecture that allows for extensible processing steps:

1. **Pipeline Step Interface** (`PipelineStep.kt`)
   - Base abstraction for all processing steps
   - Supports data sharing through `PipelineContext`
   - Enables composable, sequential processing

2. **Audio Transcription Step** (`AudioTranscriptionService.kt`)
   - Integrates Fireworks AI Whisper v3 Large model
   - Converts audio files (WAV format) to text
   - Handles multipart form-data API requests

3. **Agent Response Step** (`AgentResponseService.kt`)
   - Processes transcribed text with LangChain4j
   - Generates Figma FrameNode responses
   - Considers cursor context and drawn paths

4. **Pipeline Orchestrator** (`AudioAgentPipelineOrchestrator.kt`)
   - Coordinates the complete pipeline execution
   - Provides both direct and modular pipeline APIs
   - Manages data flow between steps

### WebSocket Integration

The pipeline is integrated with the WebSocket message handler (`CompletionsMessageHandler.kt`):

- Accumulates audio chunks during the session
- Processes complete recordings on `completion_request_end`
- Streams AI responses back through WebSocket
- Maintains connection context (cursor position, drawn paths)

## Configuration

### Environment Variables

Add these to your `.env` file:

```env
# Fireworks AI Configuration (for audio transcription)
FIREWORKS_API_KEY=your-fireworks-api-key-here
FIREWORKS_API_BASE_URL=https://api.fireworks.ai
FIREWORKS_WHISPER_MODEL=whisper-v3-large

# OpenAI Configuration (for agent response generation)
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_PROJECT_ID=your-project-id
OPENAI_ORG_ID=your-org-id

# Agent Model Configuration
AGENT_MODEL_NAME=gpt-4o-mini
```

### Application Configuration

The pipeline is configured in `application.yaml`:

```yaml
fireworks:
  api:
    key: "${FIREWORKS_API_KEY}"
    base-url: "${FIREWORKS_API_BASE_URL:https://api.fireworks.ai}"
  whisper:
    model: "${FIREWORKS_WHISPER_MODEL:whisper-v3-large}"

agent:
  model:
    name: "${AGENT_MODEL_NAME:gpt-4o-mini}"
```

## Usage

### WebSocket Protocol

The pipeline is triggered through WebSocket messages:

1. **Start Recording** - Open WebSocket connection to `/ws`

2. **Send Audio Chunks** - Send `completion_request` messages:
```json
{
  "type": "completions:request",
  "payload": {
    "fe_id": "unique-frontend-id",
    "drawn_path": "M 0 0 L 100 100 Z",
    "audio_chunk": "base64EncodedAudioData...",
    "timestamp": 1704067200000
  },
  "requestId": "request-123"
}
```

3. **End Recording** - Send `completion_request_end` message:
```json
{
  "type": "completions:request_end",
  "payload": {
    "fe_id": "unique-frontend-id"
  },
  "requestId": "request-124"
}
```

4. **Receive Response** - Get AI-generated response:
```json
{
  "type": "completions:response",
  "payload": {
    "fe_id": "unique-frontend-id",
    "response": "{\"id\":\"frame-123\",\"name\":\"Button\",\"width\":100,\"height\":40}",
    "status": "completed"
  },
  "requestId": "request-124"
}
```

### Direct API Usage

You can also use the pipeline directly in Kotlin code:

```kotlin
@Inject
lateinit var orchestrator: AudioAgentPipelineOrchestrator

suspend fun processAudioFile(audioFile: File) {
    val frameNode = orchestrator.processAudio(
        audioFile = audioFile,
        cursorContext = "User is editing a button component",
        drawnPath = "M 0 0 L 100 100"
    )
    
    println("Generated FrameNode: ${frameNode.id}")
}
```

## Pipeline Extensibility

The modular architecture allows adding new processing steps:

```kotlin
class MyCustomStep : PipelineStep<InputType, OutputType> {
    override suspend fun execute(input: InputType, context: PipelineContext): OutputType {
        // Your custom processing logic
        val result = processInput(input)
        
        // Share data with other steps
        context.put("myData", result)
        
        return result
    }
    
    override fun getName(): String = "MyCustomStep"
}

// Use in pipeline
val pipeline = pipeline<AudioTranscriptionRequest>()
    .withName("ExtendedPipeline")
    .addStep(audioTranscriptionStep)
    .addStep(myCustomStep)
    .addStep(agentResponseStep)
    .build()
```

## Audio Format Requirements

- **Format**: WAV (PCM)
- **Sample Rate**: 16000 Hz (16 kHz)
- **Bit Depth**: 16-bit signed integer (I16)
- **Channels**: Mono (1 channel)
- **Encoding**: Base64 for WebSocket transmission

## Implementation Details

### Audio Accumulation

Audio chunks are accumulated in memory during the WebSocket session:

- Thread-safe `ConcurrentHashMap` for multiple connections
- `ByteArrayOutputStream` for efficient chunk concatenation
- Automatic WAV file generation on connection close

### Transcription Process

1. Audio file is sent to Fireworks AI via multipart form-data
2. Whisper v3 Large model processes the audio
3. Transcribed text is returned and stored in pipeline context

### Agent Processing

1. Transcribed text is combined with cursor context
2. LangChain4j builds a comprehensive prompt
3. OpenAI model generates a FrameNode JSON response
4. Response is parsed and validated

### Streaming Responses

Responses are streamed back through the WebSocket connection:

- Asynchronous processing using Kotlin coroutines
- Immediate acknowledgment of request
- Completion notification with full response

## Error Handling

The pipeline includes comprehensive error handling:

- Invalid audio file detection
- API failure recovery
- JSON parsing validation
- WebSocket disconnection cleanup

Errors are logged and returned through the WebSocket as error responses:

```json
{
  "type": "error",
  "payload": {
    "fe_id": "unique-frontend-id"
  },
  "requestId": "request-124",
  "error": "Pipeline processing failed: [error details]"
}
```

## Testing

Unit tests are provided for:

- Pipeline architecture (`PipelineStepTest.kt`)
- Data models and structures (`AudioAgentPipelineTest.kt`)
- Context sharing between steps

Integration tests would require:
- Mock Fireworks AI server
- Mock OpenAI server
- Testcontainers setup

## Performance Considerations

- **Memory**: Audio is buffered in memory during sessions
- **Concurrency**: Virtual threads for parallel message processing
- **Latency**: Transcription typically takes 1-5 seconds depending on audio length
- **Rate Limits**: Respect Fireworks AI and OpenAI API rate limits

## Future Enhancements

Potential extensions to the pipeline:

1. **Audio Preprocessing** - Noise reduction, normalization
2. **Language Detection** - Automatic language identification
3. **Sentiment Analysis** - Analyze tone and emotion
4. **Multi-turn Conversations** - Context preservation across requests
5. **Custom Models** - Support for fine-tuned models
6. **Caching** - Cache common transcriptions and responses

## Dependencies

The implementation uses:

- **LangChain4j** (v1.1.0) - Agent framework
- **Java HTTP Client** - Fireworks AI API calls
- **Quarkus WebSockets** - Real-time communication
- **Jackson** - JSON processing
- **Kotlin Coroutines** - Asynchronous processing

## Security Considerations

- API keys are loaded from environment variables
- WebSocket connections require JWT authentication
- Audio files are temporarily stored and can be cleaned up
- No sensitive data is logged

## Troubleshooting

### Transcription Fails

- Check Fireworks API key is valid
- Verify audio format (16kHz, 16-bit, mono WAV)
- Check audio file size limits

### Agent Response Errors

- Verify OpenAI API key and quota
- Check model name configuration
- Review prompt structure in logs

### WebSocket Connection Issues

- Ensure JWT token is valid and not expired
- Check CORS configuration
- Verify WebSocket upgrade headers
