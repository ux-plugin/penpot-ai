import {
  Request,
  Response,
  MessageCategory,
  isRequest,
  isResponse,
  isPluginFrameMessage,
  HandlerNotFoundError,
} from "@/shared/types/messageTypes";

export type RequestHandler<TReq extends Request = Request, TRes = any> =
  (request: TReq) => Promise<TRes> | TRes;

type ResolveFunction<T = any> = (value: T) => void;
type RejectFunction = (reason: any) => void;

export interface RequestHandlerRegistry {
  [key: string]: RequestHandler<any, any>;
}

export class UniversalMessageDispatcher {
  private handlers: RequestHandlerRegistry = {};
  private pendingRequests: Map<string, { 
    resolve: ResolveFunction<any>, 
    reject: RejectFunction,
    timeout: number
  }> = new Map();
  private nextId: number = 1;
  private context: 'ui' | 'code';
  private postMessage: (message: any) => void;
  private defaultTimeout: number = 30000; // 30 seconds

  constructor(context: 'ui' | 'code', postMessageFn: (message: any) => void) {
    this.context = context;
    this.postMessage = postMessageFn;
  }

  /**
   * Helper function to safely extract error message from unknown error types
   */
  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      return String(error.message);
    }
    return 'Unknown error';
  }

  /**
   * Register a handler for specific request types with enhanced type safety
   */
  public registerHandler<
    TReq extends Request = Request,
    TRes = any
  >(
    category: MessageCategory,
    type: string,
    handler: RequestHandler<TReq, TRes>
  ): void {
    const key = `${category}:${type}`;
    if (this.handlers[key]) {
      console.warn(`Handler for ${key} already exists. Replacing existing handler.`);
    }
    this.handlers[key] = handler as RequestHandler<any, any>;
  }

  /**
   * Send a request and wait for a response
   */
  public async sendRequest<TReq extends Omit<Request, 'id' | 'timestamp' | 'source'>, TRes = any>(
    request: TReq,
    timeoutMs?: number
  ): Promise<TRes> {
    const id = this.generateId();
    
    return new Promise<TRes>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${request.category}:${request.type} (${timeoutMs || this.defaultTimeout}ms)`));
      }, timeoutMs || this.defaultTimeout);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout
      });

      // Create the full request
      const fullRequest: Request = {
        ...request,
        id,
        timestamp: Math.floor(Date.now() / 1000),
        source: this.context
      } as Request;

      this.postMessage(fullRequest);
    });
  }

  /**
   * Handle incoming messages (requests and responses)
   */
  public async handleMessage(message: unknown): Promise<void> {
    if (!isPluginFrameMessage(message)) {
      return;
    }
    try {
      if (isResponse(message)) {
        await this.handleResponse(message);
      } else if (isRequest(message)) {
        await this.handleRequest(message);
      }
    } catch (error) {
      console.error("Error handling message:", error);

      if (isRequest(message)) {
        this.sendResponse(message, null, this.getErrorMessage(error));
      }
    }
  }

  private async handleRequest(request: Request): Promise<void> {
    const key = `${request.category}:${request.type}`;
    const handler = this.handlers[key];

    if (!handler) {
      const error = new HandlerNotFoundError(request.category, request.type, { requestId: request.id });
      console.warn(error.message);
      this.sendResponse(request, null, error.message);
      return;
    }

    try {
      // Execute the single handler
      const result = await handler(request);
      this.sendResponse(request, result);
    } catch (error) {
      this.sendResponse(request, null, this.getErrorMessage(error));
    }
  }

  private async handleResponse(response: Response): Promise<void> {
    const pendingRequest = this.pendingRequests.get(response.id);
    
    if (!pendingRequest) {
      console.warn(`No pending request found for response ID: ${response.id}`);
      return;
    }

    // Clear timeout
    clearTimeout(pendingRequest.timeout);
    this.pendingRequests.delete(response.id);

    // Resolve or reject the promise
    if (!response.success || response.error) {
      pendingRequest.reject(new Error(response.error || 'Request failed'));
    } else {
      pendingRequest.resolve(response.result);
    }
  }

  private sendResponse(
    originalRequest: Request,
    result: any,
    error?: string
  ): void {
    const response: Response = {
      id: originalRequest.id,
      type: originalRequest.type,
      category: originalRequest.category,
      timestamp: Math.floor(Date.now() / 1000),
      source: this.context,
      success: !error,
      result,
      error
    } as Response;

    this.postMessage(response);
  }

  private generateId(): string {
    return `${this.context}_${Date.now()}_${this.nextId++}`;
  }

  /**
   * Get number of pending requests (for debugging)
   */
  public getPendingRequestsCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Clear all pending requests (cleanup)
   */
  public clearPendingRequests(): void {
    for (const [_, request] of this.pendingRequests) {
      clearTimeout(request.timeout);
      request.reject(new Error('Dispatcher cleared'));
    }
    this.pendingRequests.clear();
  }
}
