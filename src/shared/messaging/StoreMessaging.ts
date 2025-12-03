import { UniversalMessageDispatcher } from "./MessageDispatcher";
import {
  ExtractResultType,
  MessageCategory,
  MessageValidationError,
  StoreGetStateRequest,
  StoreMessageType,
  StoreStateUpdateRequest,
  StoreStateUpdateResponse
} from "@/shared/types/messageTypes";

// Enhanced store interface with generic state type (camelCase only)
export interface StoreWithState<TState = any> {
  setState?: (data: Partial<TState>) => void | Promise<void>;
  getState?: () => TState;
}

// Store operation result types
export interface StoreUpdateResult {
  storeId: string;
  updated: boolean;
  timestamp: number;
}

export interface StoreStateResult<TState = any> {
  storeId: string;
  state: TState;
  timestamp: number;
}

// Enhanced error types for store operations
export class StoreNotFoundError extends Error {
  constructor(storeId: string) {
    super(`Store '${storeId}' not found`);
    this.name = 'StoreNotFoundError';
  }
}

export class StoreMethodNotFoundError extends Error {
  constructor(storeId: string, method: string) {
    super(`Store '${storeId}' doesn't have '${method}' method`);
    this.name = 'StoreMethodNotFoundError';
  }
}

// Utility type for store registration
export type RegisterableStore<TState = any> = StoreWithState<TState> & Record<string, any>;

export class StoreMessaging {
  private dispatcher: UniversalMessageDispatcher;
  private stores: Map<string, RegisterableStore<any>> = new Map();

  constructor(dispatcher: UniversalMessageDispatcher) {
    this.dispatcher = dispatcher;
    this.setupHandlers();
  }

  /**
   * Register a store with enhanced type safety and validation
   */
  public registerStore<TState = any>(
    storeId: string, 
    store: RegisterableStore<TState>
  ): void {
    if (!storeId) {
      throw new MessageValidationError('Store ID must be a non-empty string', { storeId });
    }

    if (!store || typeof store !== 'object') {
      throw new MessageValidationError('Store must be a valid object', { storeId, store });
    }

    // Validate that store has at least one of the required methods
    if (!store.setState && !store.getState) {
      throw new MessageValidationError(
        'Store must implement at least one of: setState, getState', 
        { storeId, availableMethods: Object.keys(store).filter(key => typeof store[key] === 'function') }
      );
    }

    // Warn if overwriting existing store
    if (this.stores.has(storeId)) {
      console.warn(`[StoreMessaging] Overwriting existing store: ${storeId}`);
    }

    this.stores.set(storeId, store);
    console.log(`[StoreMessaging] Store registered: ${storeId}`);
  }

  /**
   * Update state and wait for confirmation with enhanced type safety
   */
  public async updateState<TPayload = any>(
    storeId: string, 
    payload: TPayload
  ): Promise<ExtractResultType<StoreStateUpdateResponse> & StoreUpdateResult> {
    if (!storeId) {
      throw new MessageValidationError("Store ID must be a non-empty string", {
        storeId,
      });
    }

    return await this.dispatcher.sendRequest<
      Omit<StoreStateUpdateRequest, "id" | "timestamp" | "source">,
      ExtractResultType<StoreStateUpdateResponse> & StoreUpdateResult
    >({
      category: MessageCategory.STORE,
      type: StoreMessageType.STATE_UPDATE,
      storeId,
      payload,
    });
  }

  /**
   * Get current state from remote store with enhanced type safety
   */
  public async getState<TState = any>(
    storeId: string
  ): Promise<StoreStateResult<TState>> {
    if (!storeId) {
      throw new MessageValidationError("Store ID must be a non-empty string", {
        storeId,
      });
    }

    return await this.dispatcher.sendRequest<
      Omit<StoreGetStateRequest, "id" | "timestamp" | "source">,
      StoreStateResult<TState>
    >({
      category: MessageCategory.STORE,
      type: StoreMessageType.GET_STATE,
      storeId,
      payload: {},
    });
  }

  /**
   * Validate if a store exists
   */
  public validateStoreExists(storeId: string): boolean {
    return this.stores.has(storeId);
  }

  /**
   * Get all registered store IDs
   */
  public getRegisteredStores(): string[] {
    return Array.from(this.stores.keys());
  }

  /**
   * Clear all registered stores
   */
  public clearAllStores(): void {
    this.stores.clear();
  }

  /**
   * Get store count
   */
  public getStoreCount(): number {
    return this.stores.size;
  }

  private setupHandlers(): void {
    this.dispatcher.registerHandler(
      MessageCategory.STORE,
      StoreMessageType.STATE_UPDATE,
      this.handleStateUpdate.bind(this)
    );

    this.dispatcher.registerHandler<StoreGetStateRequest>(
      MessageCategory.STORE,
      StoreMessageType.GET_STATE,
      this.handleGetState.bind(this)
    );
  }

  private async handleStateUpdate(request: StoreStateUpdateRequest): Promise<StoreUpdateResult> {
    const store = this.stores.get(request.storeId);

    if (!store) {
      throw new StoreNotFoundError(request.storeId);
    }

    const stateUpdateMethod = store.setState;

    if (!stateUpdateMethod || typeof stateUpdateMethod !== 'function') {
      throw new StoreMethodNotFoundError(request.storeId, 'setState');
    }

    try {
      // Ensure we fully await the promise and return only serializable data
      await stateUpdateMethod(request.payload);

      // Return a plain object that can be safely cloned
      const result: StoreUpdateResult = {
        storeId: request.storeId,
        updated: true,
        timestamp: Math.floor(Date.now() / 1000)
      };

      return result;
    } catch (error) {
      throw new Error(`Failed to update state for store '${request.storeId}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  private async handleGetState<TState = any>(request: StoreGetStateRequest): Promise<StoreStateResult<TState>> {
    const store = this.stores.get(request.storeId);
    
    if (!store) {
      throw new StoreNotFoundError(request.storeId);
    }

    let currentState: TState;

    try {
      // Only support camelCase naming convention
      const getStateMethod = store.getState;

      if (getStateMethod && typeof getStateMethod === 'function') {
        currentState = await getStateMethod();
      } else {
        // Fallback: return a copy of the store object (excluding methods)
        const storeClone = { ...store };
        // Remove function properties to get only data
        Object.keys(storeClone).forEach(key => {
          if (typeof storeClone[key] === 'function') {
            delete storeClone[key];
          }
        });
        currentState = storeClone as TState;
      }

      return {
        storeId: request.storeId,
        state: currentState,
        timestamp: Math.floor(Date.now() / 1000)
      };
    } catch (error) {
      throw new Error(`Failed to get state for store '${request.storeId}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
