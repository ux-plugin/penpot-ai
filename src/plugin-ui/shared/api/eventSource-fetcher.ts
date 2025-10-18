import { apiFetch } from "./api-fetcher.ts";
import { parseSSEStream } from "./sse-parser.ts";

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

        try {
          await parseSSEStream(reader, {
            onEvent: (event) => {
              // Log event metadata if present
              if (event.event) console.log('Event type:', event.event);
              if (event.id) console.log('Event ID:', event.id);
              if (event.retry) console.log('Server suggested retry interval:', event.retry);
            },
            onMessage: (parsed) => {
              this.lastMessage = parsed;
              onMessage?.(parsed);
            },
            onError,
            shouldContinue: () => this.isActive
          });
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
