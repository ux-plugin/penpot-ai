# Koog AI Agent Pipeline

## Overview

This feature implements an AI agent pipeline using the Koog framework (Kotlin-based AI agent framework) that processes complete recorded audio sessions and returns AI-generated responses. The pipeline integrates Fireworks AI's Whisper v3 Large model for transcription as an internal step.

## Architecture

### Pipeline Flow

```
Audio Recording (WAV) 
    ↓
Step 1: Fireworks AI Whisper v3 Large Transcription
    ↓
Transcribed Text + Cursor Context
    ↓
Step 2: Koog AI Agent (LLM Processing)
    ↓
Streaming Response via WebSocket
```

### Components

#### 1. FireworksTranscriptionService

Location: `src/main/kotlin/com/plugin/features/completions/koog/FireworksTranscriptionService.kt`

**Purpose**: Transcribes audio files using Fireworks AI's Whisper v3 Large model

**Key Features**:
- Handles WAV audio files (16kHz, mono, 16-bit PCM)
- Makes HTTP requests to Fireworks AI API
- Returns transcribed text for further processing

**API Endpoint**: `https://api.fireworks.ai/inference/v1/audio/transcriptions`

#### 2. KoogAgentPipeline

Location: `src/main/kotlin/com/plugin/features/completions/koog/KoogAgentPipeline.kt`

**Purpose**: Orchestrates the complete pipeline from audio transcription to LLM response generation

**Key Features**:
- Coordinates transcription and LLM processing steps
- Uses Koog's streaming API for real-time response delivery
- Combines transcribed audio with cursor context (drawn paths)
- Streams responses through WebSocket channels

**Pipeline Steps**:
1. **Transcription**: Convert audio file to text using Fireworks AI Whisper
2. **Agent Processing**: Process transcribed text + cursor context using Koog AI agent
3. **Streaming**: Stream response chunks back to client via WebSocket

#### 3. CompletionsMessageHandler Integration

Location: `src/main/kotlin/com/plugin/features/completions/CompletionsMessageHandler.kt`

**Purpose**: WebSocket message handler that integrates the Koog pipeline

**Enhanced Functionality**:
- Accumulates audio chunks during WebSocket session
- Accumulates drawn path context
- Triggers Koog pipeline on `completion_request_end` message
- Streams LLM responses back to client in real-time

## Configuration

### Environment Variables

Add these to your `.env` file or environment:

```bash
# Required: Fireworks AI API key for Whisper transcription
FIREWORKS_API_KEY=your-fireworks-api-key-here

# Required: OpenAI API key for LLM responses
OPENAI_API_KEY=your-openai-api-key-here

# Optional: LLM model selection (default: gpt-4o-mini)
KOOG_LLM_MODEL=gpt-4o-mini

# Optional: LLM temperature (default: 0.7)
KOOG_LLM_TEMPERATURE=0.7

# Optional: Max agent iterations (default: 10)
KOOG_MAX_ITERATIONS=10
```

### application.yaml Configuration

The Koog pipeline is configured in `src/main/resources/application.yaml`:

```yaml
koog:
  # Fireworks AI API key for Whisper v3 Large transcription
  fireworks:
    api-key: "${FIREWORKS_API_KEY:}"
  
  # OpenAI API key for LLM responses
  openai:
    api-key: "${OPENAI_API_KEY}"
  
  # LLM model configuration
  llm:
    model: "${KOOG_LLM_MODEL:gpt-4o-mini}"
    temperature: "${KOOG_LLM_TEMPERATURE:0.7}"
  
  # Agent configuration
  agent:
    max-iterations: "${KOOG_MAX_ITERATIONS:10}"
```

## WebSocket Protocol

### Message Flow

#### 1. Client sends audio chunks

```json
{
  "type": "completions:completion_request",
  "payload": {
    "fe_id": "unique-frontend-id",
    "timestamp": 1704067200000,
    "drawn_path": "M 0 0 L 100 100 Z",
    "audio_chunk": "base64EncodedAudioData..."
  },
  "requestId": "request-123"
}
```

#### 2. Client signals end of recording

```json
{
  "type": "completions:completion_request_end",
  "payload": {
    "fe_id": "unique-frontend-id"
  },
  "requestId": "request-124"
}
```

#### 3. Server streams responses

```json
{
  "type": "completions:completion_response",
  "payload": {
    "fe_id": "unique-frontend-id",
    "response_chunk": "Here is my analysis..."
  },
  "requestId": "request-124"
}
```

#### 4. Server signals completion

```json
{
  "type": "completions:completion_response_end",
  "payload": {
    "fe_id": "unique-frontend-id",
    "status": "completed"
  },
  "requestId": "request-124"
}
```

## System Prompt

The AI agent is configured with a system prompt that defines its role:

```
You are an intelligent AI assistant that helps users with their tasks based on audio input and visual context.

You receive:
1. Transcribed text from user's audio recording
2. User's cursor context (e.g., drawing path, position on canvas)

Your role is to:
- Understand the user's intent from their speech
- Consider the visual context provided (cursor position, drawn paths)
- Generate helpful, contextual responses
- Provide actionable suggestions when appropriate

Be concise, helpful, and contextually aware. If the audio transcription is unclear or incomplete, 
ask for clarification.
```

## Dependencies

### Koog Framework

```gradle
implementation 'ai.koog:koog-agents:0.5.2'
implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2'
implementation 'org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1'
```

### HTTP Client for Fireworks API

```gradle
implementation 'com.squareup.okhttp3:okhttp:4.12.0'
```

## Usage Example

### Starting the Server

```bash
export FIREWORKS_API_KEY=your-fireworks-api-key
export OPENAI_API_KEY=your-openai-api-key
./gradlew quarkusDev
```

### Connecting via WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8080/completions/create?token=your-jwt-token');

ws.onopen = () => {
    console.log('Connected to Koog pipeline');
    
    // Send audio chunks as you record
    const message = {
        type: 'completions:completion_request',
        payload: {
            fe_id: 'unique-id',
            timestamp: Date.now(),
            drawn_path: 'M 0 0 L 100 100',
            audio_chunk: base64AudioData
        },
        requestId: 'req-1'
    };
    
    ws.send(JSON.stringify(message));
};

ws.onmessage = (event) => {
    const response = JSON.parse(event.data);
    
    if (response.type === 'completions:completion_response') {
        // Stream response chunks
        console.log('Agent response:', response.payload.response_chunk);
    } else if (response.type === 'completions:completion_response_end') {
        console.log('Agent finished processing');
    }
};

// When recording ends
ws.send(JSON.stringify({
    type: 'completions:completion_request_end',
    payload: { fe_id: 'unique-id' },
    requestId: 'req-2'
}));
```

## Modular Design

The pipeline is designed to be modular and extensible:

1. **Transcription Step**: Can be replaced with other transcription services
2. **LLM Step**: Can use different LLM providers (OpenAI, Anthropic, Google, etc.)
3. **Additional Steps**: New pipeline steps can be added easily using Koog's graph-based workflow

### Adding New Pipeline Steps

To add a new step to the pipeline, modify `KoogAgentPipeline.kt`:

```kotlin
// Example: Add a sentiment analysis step
val sentimentAnalysisStep = { text: String ->
    // Analyze sentiment
    analyzeSentiment(text)
}

// Integrate into pipeline
val transcribedText = transcriptionService.transcribeAudio(audioFile)
val sentiment = sentimentAnalysisStep(transcribedText)
generateAgentResponse(transcribedText, sentiment, cursorContext, streamChannel)
```

## Error Handling

The pipeline includes comprehensive error handling:

- **Transcription Failures**: Logged and error message sent to client
- **LLM Failures**: Handled by Koog's event system with `onAgentExecutionFailed`
- **WebSocket Errors**: Connection cleanup and buffer management
- **API Rate Limits**: Handled by the underlying HTTP client with appropriate timeouts

## Performance Considerations

1. **Audio File Size**: Audio files are saved temporarily during processing
2. **Memory Usage**: Audio chunks are accumulated in memory before processing
3. **Streaming**: Responses are streamed in real-time to reduce latency
4. **Concurrency**: Multiple WebSocket sessions can process audio simultaneously

## Troubleshooting

### Issue: Transcription fails with 401 Unauthorized

**Solution**: Check that `FIREWORKS_API_KEY` is set correctly

### Issue: LLM responses are slow

**Solution**: Consider using a faster model or adjusting the temperature setting

### Issue: Audio quality is poor

**Solution**: Ensure audio is recorded at 16kHz, mono, 16-bit PCM format

### Issue: WebSocket connection drops

**Solution**: Check auto-ping configuration in `application.yaml`

## References

- [Koog Framework](https://github.com/JetBrains/koog)
- [Koog Documentation](https://docs.koog.ai/)
- [Koog Examples](https://github.com/JetBrains/koog/tree/develop/examples/simple-examples)
- [Fireworks AI API](https://docs.fireworks.ai/)
