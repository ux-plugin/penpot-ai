import { UniversalMessageDispatcher } from './MessageDispatcher';
import {
  MessageCategory,
  StoreMessageType,
  StoreStateUpdateRequest,
  StoreGetStateRequest,
  StoreStateUpdateResponse,
  StoreGetStateResponse,
} from "@/types/messageTypes";

export class StoreMessaging {
  private dispatcher: UniversalMessageDispatcher;
  private stores: Map<string, any> = new Map();

  constructor(dispatcher: UniversalMessageDispatcher) {
    this.dispatcher = dispatcher;
    this.setupHandlers();
  }

  /**
   * Register a store with the set_state and get_state functions
   */
  public registerStore<T>(storeId: string, store: T & { 
    set_state?: (data: any) => void;
    get_state?: () => any;
  }): void {
    this.stores.set(storeId, store);
  }

  /**
   * Update state and wait for confirmation
   */
  public async updateState(storeId: string, payload: any): Promise<any> {
    return this.dispatcher.sendRequest<Omit<StoreStateUpdateRequest, "id"| "timestamp"| "source">, StoreStateUpdateResponse>({
      category: MessageCategory.STORE,
      type: StoreMessageType.STATE_UPDATE,
      storeId,
      payload
    });
  }


  /**
   * Get current state from remote store
   */
  public async getState(storeId: string): Promise<any> {
    return this.dispatcher.sendRequest<Omit<StoreGetStateRequest, "id"| "timestamp"| "source">, StoreGetStateResponse>({
      category: MessageCategory.STORE,
      type: StoreMessageType.GET_STATE,
      storeId,
      payload: {}
    });
  }

  private setupHandlers(): void {
    this.dispatcher.registerHandler(
      MessageCategory.STORE,
      StoreMessageType.STATE_UPDATE,
      this.handleStateUpdate.bind(this)
    );

    this.dispatcher.registerHandler(
      MessageCategory.STORE,
      StoreMessageType.GET_STATE,
      this.handleGetState.bind(this)
    );
  }

  private async handleStateUpdate(request: StoreStateUpdateRequest): Promise<any> {
    const store = this.stores.get(request.storeId);
    if (store && store.set_state) {
      store.set_state(request.payload);
      return {
        storeId: request.storeId,
        updated: true,
        payload: request.payload
      };
    } else {
      throw new Error(`Store ${request.storeId} not found or doesn't have set_state method`);
    }
  }


  private async handleGetState(request: StoreGetStateRequest): Promise<any> {
    const store = this.stores.get(request.storeId);
    
    if (!store) {
      throw new Error(`Store ${request.storeId} not found`);
    }

    let currentState;
    if (store.get_state && typeof store.get_state === 'function') {
      currentState = store.get_state();
    } else if (store.getState && typeof store.getState === 'function') {
      currentState = store.getState();
    } else {
      currentState = { ...store };
    }

    return {
      storeId: request.storeId,
      state: currentState
    };
  }
}