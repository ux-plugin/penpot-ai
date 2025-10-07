import { apiFetch } from "./api-fetcher.ts";

export interface StreamingConnectionOptions<T> {
  onMessage?: (data: T) => void;
  onError?: (error: Error) => void;
  onOpen?: (connection: StreamingConnectionImpl) => void;
  onClose?: () => void;
  includeAuth?: boolean;
  maxRetries?: number;
  retryInterval?: number;
}

export interface StreamingConnection {
  close(): void;
  isConnected(): boolean;
  getLastMessage(): any;
  connect(): Promise<void>;
}

class StreamingConnectionImpl implements StreamingConnection {
  private isActive = false;
  private lastMessage: any = null;
  private abortController: AbortController | null = null;
  private retryTimeout: number | null = null;
  private onCloseCallback?: () => void;

  constructor(
    private endpoint: string,
    private options: StreamingConnectionOptions<any>
  ) {}

  async connect(): Promise<void> {
    const {
      onMessage,
      onError,
      onOpen,
      onClose,
      includeAuth = true,
      maxRetries = 5,
      retryInterval = 5000
    } = this.options;

    this.onCloseCallback = onClose;
    let retryCount = 0;

    const attemptConnection = async (): Promise<void> => {
      try {
        this.abortController = new AbortController();
        
        const response = await apiFetch(this.endpoint, {
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
          signal: this.abortController.signal,
        }, includeAuth);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        this.isActive = true;
        retryCount = 0; // Reset retry count on successful connection
        console.log('Streaming connection established');
        onOpen?.(this);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (this.isActive) {
            const { done, value } = await reader.read();

            if (done) {
              console.log('Stream ended');
              break;
            }

            // Decode the chunk and add to buffer
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Process complete lines
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in the buffer

            let eventData = '';
            
            for (const line of lines) {
              if (line.trim() === '') {
                // Empty line indicates the end of event, process accumulated data
                if (eventData) {
                  this.processEventData(eventData, onMessage, onError);
                  eventData = '';
                }
              } else if (line.startsWith('data:')) {
                // Accumulate data lines
                const data = line.slice(5);
                eventData += (eventData ? '\n' : '') + data;
              } else if (line.startsWith('event:')) {
                // Handle event type if needed
                const eventType = line.slice(7);
                console.log('Event type:', eventType);
              } else if (line.startsWith('id:')) {
                // Handle event ID if needed
                const eventId = line.slice(4);
                console.log('Event ID:', eventId);
              } else if (line.startsWith('retry:')) {
                // Handle retry interval if needed
                const retryMs = parseInt(line.slice(7), 10);
                console.log('Server suggested retry interval:', retryMs);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

      } catch (error: any) {
        if (error.name === 'AbortError') {
          // Connection was manually closed
          return;
        }

        console.error('Streaming connection error:', error);
        
        if (this.isActive && retryCount < maxRetries) {
          retryCount++;
          console.log(`Streaming connection retry ${retryCount}/${maxRetries} in ${retryInterval}ms`);
          
          this.retryTimeout = window.setTimeout(() => {
            attemptConnection().catch((retryError) => {
              onError?.(retryError instanceof Error ? retryError : new Error(String(retryError)));
            });
          }, retryInterval);
        } else if (this.isActive) {
          const errorMessage = `Streaming connection failed after ${maxRetries} attempts: ${error.message}`;
          onError?.(new Error(errorMessage));
          this.close();
        }
      }
    };

    await attemptConnection();
  }

  private processEventData(data: string, onMessage?: (data: any) => void, onError?: (error: Error) => void): void {
    if (!data.trim()) return;

    try {
      const parsed = JSON.parse(data);
      this.lastMessage = parsed;
      onMessage?.(parsed);
    } catch (parseError) {
      console.error('Failed to parse SSE data:', parseError, 'Raw data:', data);
      onError?.(new Error(`Failed to parse SSE message: ${parseError}`));
    }
  }

  close(): void {
    this.isActive = false;
    
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    
    this.onCloseCallback?.();
  }

  isConnected(): boolean {
    return this.isActive;
  }

  getLastMessage(): any {
    return this.lastMessage;
  }
}

export function createStreamingConnection<T>(
  endpoint: string,
  options: StreamingConnectionOptions<T> = {}
): StreamingConnection {

  return new StreamingConnectionImpl(endpoint, options);
}
