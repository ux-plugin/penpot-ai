import { UniversalMessageDispatcher } from '@/shared/messaging/MessageDispatcher.ts';
import { StoreMessaging } from '@/shared/messaging/StoreMessaging.ts';
import {
  MessageCategory,
  OperationMessageType,
  SystemMessageType,
  DrawRectangleRequest,
  DrawRectangleResponse,
  ErrorRequest,
  ErrorResponse,
  WorkerTestRequest,
  WorkerTestResponse,
  NodeChangedRequest,
  NodeChangedResponse,
  SelectionChangedRequest,
  SelectionChangedResponse,
  SetFigmaSelectionRequest,
  SetFigmaSelectionResponse,
  ExtractResultType
} from '@shared-types/messageTypes.ts';
import { nodeManager } from '@/plugin-ui/stores/NodeManager';
import { setSelectedIds, docProxy, subscribe } from 'skia-rs-wasm';
// Create UI message dispatcher (pluginId required for non-null origin iframes per Figma docs)
export const uiMessageDispatcher = new UniversalMessageDispatcher(
  'ui',
  (message) =>
    parent.postMessage(
      { pluginMessage: message, pluginId: import.meta.env.VITE_PLUGIN_ID ?? '*' },
      '*'
    )
);

// Create store messaging
export const uiStoreMessaging = new StoreMessaging(uiMessageDispatcher);

// Setup message listener
window.onmessage = (event: MessageEvent) => {
  const message = event.data.pluginMessage;
  if (message) {
    uiMessageDispatcher.handleMessage(message);
  }
};

// Register operation handlers with enhanced type safety
uiMessageDispatcher.registerHandler<
  DrawRectangleRequest,
  ExtractResultType<DrawRectangleResponse>
>(
  MessageCategory.OPERATION,
  OperationMessageType.DRAW_RECTANGLE,
  async (request: DrawRectangleRequest): Promise<ExtractResultType<DrawRectangleResponse>> => {
    console.log('Drawing rectangle request received:', request.payload);
    // Return a response result with exact type
    return {
      nodeId: 'ui-mock-node-id',
      created: true,
      x: request.payload.x,
      y: request.payload.y,
      width: request.payload.width,
      height: request.payload.height
    };
  }
);

// Register system handlers with enhanced type safety
uiMessageDispatcher.registerHandler<
  ErrorRequest,
  ExtractResultType<ErrorResponse>
>(
  MessageCategory.SYSTEM,
  SystemMessageType.ERROR,
  async (request: ErrorRequest): Promise<ExtractResultType<ErrorResponse>> => {
    console.error('System error:', request.payload.message, request.payload.details);
    // Return a response result with exact type
    return {
      logged: true,
      handled: true
    };
  }
);

uiMessageDispatcher.registerHandler<
  WorkerTestRequest,
  ExtractResultType<WorkerTestResponse>
>(
  MessageCategory.SYSTEM,
  SystemMessageType.WORKER_TEST,
  async (request: WorkerTestRequest): Promise<ExtractResultType<WorkerTestResponse>> => {
    console.log('[UI] Worker test message received:', request.payload.message);
    console.log('[UI] Full request payload:', request.payload);
    // Return a response result with exact type
    return {
      received: true,
      echoed: `UI received: "${request.payload.message}"`,
      processedBy: 'ui' as const
    };
  }
);

// Register node change handler
uiMessageDispatcher.registerHandler<
  NodeChangedRequest,
  ExtractResultType<NodeChangedResponse>
>(
  MessageCategory.SYSTEM,
  SystemMessageType.NODE_CHANGED,
  async (request: NodeChangedRequest): Promise<ExtractResultType<NodeChangedResponse>> => {
    await nodeManager.handleNodeChange(request.payload);
    return {
      handled: true
    };
  }
);

// UI-side guard to prevent selection sync loops
const selectionSyncGuard = {
  _ignoring: false,
  startIgnoring() { this._ignoring = true; },
  stopIgnoring() { this._ignoring = false; },
  isIgnoring() { return this._ignoring; },
};

// Register selection change handler (Figma -> Plugin)
uiMessageDispatcher.registerHandler<
  SelectionChangedRequest,
  ExtractResultType<SelectionChangedResponse>
>(
  MessageCategory.SYSTEM,
  SystemMessageType.SELECTION_CHANGED,
  async (request: SelectionChangedRequest): Promise<ExtractResultType<SelectionChangedResponse>> => {
    if (selectionSyncGuard.isIgnoring()) {
      return { handled: true };
    }

    selectionSyncGuard.startIgnoring();

    nodeManager.handleSelectionChange(request.payload);

    const penpotIds = request.payload.penpotIds;
    if (penpotIds && penpotIds.length > 0) {
      setSelectedIds(new Set(penpotIds));
    } else {
      setSelectedIds(new Set());
    }

    return { handled: true };
  }
);

// Sync plugin canvas selection -> Figma via Valtio subscriber
let lastSyncedIds = '';
subscribe(docProxy, () => {
  const currentIds = Array.from(docProxy.selectedIds).sort().join(',');
  if (currentIds === lastSyncedIds) return;
  lastSyncedIds = currentIds;

  if (selectionSyncGuard.isIgnoring()) {
    selectionSyncGuard.stopIgnoring();
    return;
  }

  const penpotIds = Array.from(docProxy.selectedIds);
  uiMessageDispatcher.sendRequest<
    Omit<SetFigmaSelectionRequest, 'id' | 'timestamp' | 'source'>,
    ExtractResultType<SetFigmaSelectionResponse>
  >({
    category: MessageCategory.SYSTEM,
    type: SystemMessageType.SET_FIGMA_SELECTION,
    payload: { penpotIds },
  }).catch((err) =>
    console.warn('[SelectionSync] Failed to set Figma selection:', err),
  );
});
