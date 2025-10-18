/**
 * Shared SSE (Server-Sent Events) parser utility
 * Provides reusable SSE stream parsing with customizable data processing
 */

export interface SSEEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export interface SSEParserOptions<T> {
  /**
   * Callback when a complete SSE event is received
   */
  onEvent: (event: SSEEvent) => void;
  
  /**
   * Callback when message data is parsed successfully
   * If not provided, raw event will be passed through
   */
  onMessage?: (data: T) => void;
  
  /**
   * Custom data parser function
   * Defaults to JSON.parse if not provided
   */
  parseData?: (data: string) => T | Promise<T>;
  
  /**
   * Error handler for parsing errors
   */
  onError?: (error: Error) => void;
  
  /**
   * Check if parsing should continue
   * Useful for cancellation/cleanup
   */
  shouldContinue?: () => boolean;
}

/**
 * Parse an SSE stream from a ReadableStream reader
 * Handles buffering, line splitting, and SSE format parsing
 */
export async function parseSSEStream<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: SSEParserOptions<T>
): Promise<void> {
  const {
    onEvent,
    onMessage,
    parseData,
    onError,
    shouldContinue = () => true
  } = options;

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (shouldContinue()) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('SSE stream ended');
        break;
      }

      // Decode the chunk and add to buffer
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in the buffer

      // Process the event
      await processSSELines(lines, {
        onEvent,
        onMessage,
        parseData,
        onError
      });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Process SSE lines and extract events
 */
async function processSSELines<T>(
  lines: string[],
  options: {
    onEvent: (event: SSEEvent) => void;
    onMessage?: (data: T) => void;
    parseData?: (data: string) => T | Promise<T>;
    onError?: (error: Error) => void;
  }
): Promise<void> {
  const { onEvent, onMessage, parseData, onError } = options;
  
  let currentEvent: Partial<SSEEvent> = {};
  let eventData = '';

  for (const line of lines) {
    if (line.trim() === '') {
      // Empty line indicates the end of an event
      if (eventData) {
        const event: SSEEvent = {
          data: eventData,
          event: currentEvent.event,
          id: currentEvent.id,
          retry: currentEvent.retry
        };

        onEvent(event);

        // Process data if message handler is provided
        if (onMessage) {
          try {
            const parsed = parseData 
              ? await parseData(eventData)
              : JSON.parse(eventData) as T;
            
            onMessage(parsed);
          } catch (parseError) {
            const error = new Error(
              `Failed to parse SSE message: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            );
            console.error('SSE parse error:', error, 'Raw data:', eventData);
            onError?.(error);
          }
        }

        // Reset for next event
        eventData = '';
        currentEvent = {};
      }
    } else if (line.startsWith('data:')) {
      // Accumulate data lines (may be multiple per event)
      const data = line.slice(5).trimStart();
      eventData += (eventData ? '\n' : '') + data;
    } else if (line.startsWith('event:')) {
      // Event type
      currentEvent.event = line.slice(6).trimStart();
    } else if (line.startsWith('id:')) {
      // Event ID
      currentEvent.id = line.slice(3).trimStart();
    } else if (line.startsWith('retry:')) {
      // Retry interval
      const retryMs = parseInt(line.slice(6).trimStart(), 10);
      if (!isNaN(retryMs)) {
        currentEvent.retry = retryMs;
      }
    } else if (line.startsWith(':')) {
      // Comment line - ignore
      continue;
    }
  }
}
