import { BaseRequest, BaseResponse } from "@/types";

type ResolveFunction<T extends BaseResponse> = (value: T) => void;
type RejectFunction = (reason: any) => void;

export class MessageDispatcher {
  private pendingRequests: Map<string, { resolve: ResolveFunction<any>, reject: RejectFunction }> = new Map();
  private nextId: number = 1;

  constructor() {
    window.onmessage = this.handleMessage.bind(this);
  }

  /**
   * Sends a request to the plugin and returns a promise that resolves when the response arrives
   */
  public async sendMessage<TRes extends BaseResponse>(
    request: Omit<BaseRequest, 'id'>
  ): Promise<TRes> {
    const id = this.generateId();
    const fullRequest = { ...request, id } as BaseRequest;
    return new Promise<TRes>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      parent.postMessage({ pluginMessage: fullRequest }, '*');
    });
  }


  /**
   * Handles incoming messages from the plugin
   */
  private handleMessage<TRes extends BaseResponse>(event: MessageEvent) {
    const response = event.data.pluginMessage as TRes;

    if (!response || !response.id) {
      console.warn('Received message without proper ID', response);
      return;
    }

    const pendingRequest = this.pendingRequests.get(response.id);

    if (!pendingRequest) {
      console.warn('Received response for unknown request ID:', response.id);
      return;
    }

    // Remove the pending request from the map
    this.pendingRequests.delete(response.id);

    // Check if there's an error
    if (response.error) {
      pendingRequest.reject(new Error(response.error));
    } else {
      pendingRequest.resolve(response);
    }
  }

  /**
   * Generates a unique ID for each request
   */
  private generateId(): string {
    return `req_${Date.now()}_${this.nextId++}`;
  }
}

// Create a singleton instance to be used throughout the application
export const messageDispatcher = new MessageDispatcher();