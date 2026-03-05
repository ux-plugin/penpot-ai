// Pure Request/Response message type system for scalable communication between UI and code.ts
import type { DesignNode } from './types';

export enum MessageCategory {
  STORE = 'store',
  OPERATION = 'operation', 
  SYSTEM = 'system'
}

export enum StoreMessageType {
  STATE_UPDATE = 'state_update',
  GET_STATE = 'get_state'
}

export enum OperationMessageType {
  DRAW_RECTANGLE = 'draw_rectangle',
  CHANGE_COLOR = 'change_color',
  RESIZE_ELEMENT = 'resize_element',
  CREATE_FRAME = 'create_frame',
  COMPLETE = 'complete',
  GET_NODES_UNDER_UI = 'get_nodes_under_ui'
}

export enum SystemMessageType {
  ERROR = 'error',
  WARNING = 'warning',
  INFO = 'info',
  PLUGIN_READY = 'plugin_ready',
  WORKER_TEST = 'worker_test',
  RESIZE = 'resize',
  GET_POSITION = 'get_position',
  SYNC_CANVAS = 'sync_canvas',
  UPDATE_VIEWPORT = 'update_viewport',
  GET_VIEWPORT_BOUNDS = 'get_viewport_bounds',
  GET_ALL_NODES = 'get_all_nodes',
  EXPORT_NODE_SVGS = 'export_node_svgs',
  NODE_CHANGED = 'node_changed',
  SELECTION_CHANGED = 'selection_changed',
  SET_PENPOT_PAGE = 'set_penpot_page',
  APPLY_PENPOT_CHANGES = 'apply_penpot_changes',
  REQUEST_PENPOT_PAGE = 'request_penpot_page'
}

// Base message request interface
export interface MessageRequest {
  id: string;
  type: string;
  category: MessageCategory;
  timestamp: number;
  source: 'ui' | 'code';
}

// Base message response interface
export interface MessageResponse {
  id: string;
  type: string;
  category: MessageCategory;
  timestamp: number;
  source: 'ui' | 'code';
  success: boolean;
  error?: string;
  result?: any;
}

// ===================
// STORE MESSAGE TYPES
// ===================

// Store State Update Request/Response
export interface StoreStateUpdateRequest extends MessageRequest {
  category: MessageCategory.STORE;
  type: StoreMessageType.STATE_UPDATE;
  storeId: string;
  payload: any;
}

export interface StoreStateUpdateResponse extends MessageResponse {
  category: MessageCategory.STORE;
  type: StoreMessageType.STATE_UPDATE;
  result: {
    storeId: string;
    updated: boolean;
  };
}


// Store Get State Request/Response
export interface StoreGetStateRequest extends MessageRequest {
  category: MessageCategory.STORE;
  type: StoreMessageType.GET_STATE;
  storeId: string;
  payload: {};
}

export interface StoreGetStateResponse extends MessageResponse {
  category: MessageCategory.STORE;
  type: StoreMessageType.GET_STATE;
  result: {
    storeId: string;
    state: any;
  };
}

// ======================
// OPERATION MESSAGE TYPES
// ======================

// Draw Rectangle Request/Response
export interface DrawRectangleRequest extends MessageRequest {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.DRAW_RECTANGLE;
  payload: {
    x: number;
    y: number;
    width: number;
    height: number;
    color?: { r: number; g: number; b: number };
  };
}

export interface DrawRectangleResponse extends MessageResponse {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.DRAW_RECTANGLE;
  result: {
    nodeId: string;
    created: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// Change Color Request/Response
export interface ChangeColorRequest extends MessageRequest {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.CHANGE_COLOR;
  payload: {
    nodeId: string;
    color: { r: number; g: number; b: number };
  };
}

export interface ChangeColorResponse extends MessageResponse {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.CHANGE_COLOR;
  result: {
    nodeId: string;
    colorChanged: boolean;
    color: { r: number; g: number; b: number };
  };
}

// Create Frame Request/Response
export interface CreateFrameRequest extends MessageRequest {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.CREATE_FRAME;
  payload: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    name?: string;
  };
}

export interface CreateFrameResponse extends MessageResponse {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.CREATE_FRAME;
  result: {
    frameId: string;
    created: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
  };
}

// Complete Request/Response
export interface CompleteRequest extends MessageRequest {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.COMPLETE;
  payload: Partial<FrameNode> & {parent: string, fillStyleId: string};
}

export interface CompleteResponse extends MessageResponse {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.COMPLETE;
  result: {
    completed: boolean;
    nodeId?: string;
  };
}

// Resize Element Request/Response
export interface ResizeElementRequest extends MessageRequest {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.RESIZE_ELEMENT;
  payload: {
    nodeId: string;
    width: number;
    height: number;
  };
}

export interface ResizeElementResponse extends MessageResponse {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.RESIZE_ELEMENT;
  result: {
    nodeId: string;
    resized: boolean;
    width: number;
    height: number;
  };
}

// Get Nodes Under UI Request/Response
export interface GetNodesUnderUIRequest extends MessageRequest {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.GET_NODES_UNDER_UI;
  payload: {
    width: number;
    height: number;
  };
}


export interface GetNodesUnderUIResponse extends MessageResponse {
  category: MessageCategory.OPERATION;
  type: OperationMessageType.GET_NODES_UNDER_UI;
  result: {
    nodes: Array<{
      id: string;
      type: string;
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    totalCount: number;
    uiRegion: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  };
}

// ====================
// SYSTEM MESSAGE TYPES
// ====================

// Error Request/Response
export interface ErrorRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.ERROR;
  payload: {
    level: 'error';
    message: string;
    details?: any;
  };
}

export interface ErrorResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.ERROR;
  result: {
    logged: boolean;
    handled: boolean;
  };
}

// Warning Request/Response
export interface WarningRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.WARNING;
  payload: {
    level: 'warning';
    message: string;
    details?: any;
  };
}

export interface WarningResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.WARNING;
  result: {
    logged: boolean;
    handled: boolean;
  };
}

// Info Request/Response
export interface InfoRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.INFO;
  payload: {
    level: 'info';
    message: string;
    details?: any;
  };
}

export interface InfoResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.INFO;
  result: {
    logged: boolean;
    handled: boolean;
  };
}

// Plugin Ready Request/Response
export interface PluginReadyRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.PLUGIN_READY;
  payload: {
    version?: string;
    features?: string[];
  };
}

export interface PluginReadyResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.PLUGIN_READY;
  result: {
    ready: boolean;
    acknowledgedVersion?: string;
  };
}

// Worker Test Request/Response
export interface WorkerTestRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.WORKER_TEST;
  payload: {
    message: string;
    testData?: any;
  };
}

export interface WorkerTestResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.WORKER_TEST;
  result: {
    received: boolean;
    echoed: string;
    processedBy: 'ui' | 'code';
  };
}

// Resize Window Request/Response
export interface ResizeRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.RESIZE;
  payload: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
}

export interface ResizeResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.RESIZE;
  result: {
    resized: boolean;
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
}

// Get Position Request/Response
export interface GetPositionRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.GET_POSITION;
  payload: {};
}

export interface GetPositionResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.GET_POSITION;
  result: {
    windowSpace: { x: number; y: number };
    canvasSpace: { x: number; y: number };
  };
}

// Sync Canvas Request/Response
export interface SyncCanvasRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.SYNC_CANVAS;
  payload: {};
}

export interface SyncCanvasResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.SYNC_CANVAS;
  result: {
    canvasPosition: { x: number; y: number };
    zoom: number;
  };
}

// Update Viewport Request/Response
export interface UpdateViewportRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.UPDATE_VIEWPORT;
  payload: {
    transform: { x: number; y: number };
    zoom: number;
    zoomFocalPoint?: { x: number; y: number }; // Canvas coordinates of zoom focal point
  };
}

export interface UpdateViewportResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.UPDATE_VIEWPORT;
  result: {
    updated: boolean;
    center: { x: number; y: number };
    zoom: number;
  };
}

// Get Viewport Bounds Request/Response
export interface GetViewportBoundsRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.GET_VIEWPORT_BOUNDS;
  payload: {};
}

export interface GetViewportBoundsResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.GET_VIEWPORT_BOUNDS;
  result: {
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    center: { x: number; y: number };
    zoom: number;
  };
}

// Get All Nodes Request/Response
export interface GetAllNodesRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.GET_ALL_NODES;
  payload: {
    includeSVG?: boolean;
  };
}

export interface GetAllNodesResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.GET_ALL_NODES;
  result: {
    nodes: DesignNode[];
    totalCount: number;
  };
}

export interface ExportNodeSVGsRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.EXPORT_NODE_SVGS;
  payload: {
    nodeIds: string[];
  };
}

export interface ExportNodeSVGsResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.EXPORT_NODE_SVGS;
  result: {
    svgs: Array<{ nodeId: string; svg: string | null }>;
  };
}

// Node Changed Request/Response
export interface NodeChangedRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.NODE_CHANGED;
  payload: {
    changeType: 'property' | 'create' | 'delete';
    nodeIds: string[];
    nodes?: DesignNode[];  // Full node data for creates/updates
  };
}

export interface NodeChangedResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.NODE_CHANGED;
  result: {
    handled: boolean;
  };
}

// Selection Changed Request/Response
export interface SelectionChangedRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.SELECTION_CHANGED;
  payload: {
    selectedNodeIds: string[];
  };
}

export interface SelectionChangedResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.SELECTION_CHANGED;
  result: {
    handled: boolean;
  };
}

// Set Penpot Page (code → UI): full page for skia-rs-wasm document. Payload is serialized PenpotPage.
export interface SetPenpotPageRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.SET_PENPOT_PAGE;
  payload: {
    page: Record<string, unknown>;
  };
}

export interface SetPenpotPageResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.SET_PENPOT_PAGE;
  result: {
    handled: boolean;
  };
}

// Apply Penpot Changes (code → UI): incremental changes for skia-rs-wasm.
export interface ApplyPenpotChangesRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.APPLY_PENPOT_CHANGES;
  payload: {
    changes: Record<string, unknown>[];
    pageId?: string;
  };
}

export interface ApplyPenpotChangesResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.APPLY_PENPOT_CHANGES;
  result: {
    handled: boolean;
  };
}

// Request Penpot Page (UI → code): UI requests current page for skia-rs-wasm; code responds with page.
export interface RequestPenpotPageRequest extends MessageRequest {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.REQUEST_PENPOT_PAGE;
  payload: Record<string, never>;
}

export interface RequestPenpotPageResponse extends MessageResponse {
  category: MessageCategory.SYSTEM;
  type: SystemMessageType.REQUEST_PENPOT_PAGE;
  result: {
    page: Record<string, unknown>;
  };
}

// =================
// UNION TYPES
// =================

// All request types
export type Request = 
  | StoreStateUpdateRequest
  | StoreGetStateRequest
  | DrawRectangleRequest
  | ChangeColorRequest
  | CreateFrameRequest
  | CompleteRequest
  | ResizeElementRequest
  | GetNodesUnderUIRequest
  | ErrorRequest
  | WarningRequest
  | InfoRequest
  | PluginReadyRequest
  | WorkerTestRequest
  | ResizeRequest
  | GetPositionRequest
  | SyncCanvasRequest
  | UpdateViewportRequest
  | GetViewportBoundsRequest
  | GetAllNodesRequest
  | ExportNodeSVGsRequest
  | NodeChangedRequest
  | SelectionChangedRequest
  | SetPenpotPageRequest
  | ApplyPenpotChangesRequest
  | RequestPenpotPageRequest;

// All response types
export type Response = 
  | StoreStateUpdateResponse
  | StoreGetStateResponse
  | DrawRectangleResponse
  | ChangeColorResponse
  | CreateFrameResponse
  | CompleteResponse
  | ResizeElementResponse
  | GetNodesUnderUIResponse
  | ErrorResponse
  | WarningResponse
  | InfoResponse
  | PluginReadyResponse
  | WorkerTestResponse
  | ResizeResponse
  | GetPositionResponse
  | SyncCanvasResponse
  | UpdateViewportResponse
  | GetViewportBoundsResponse
  | GetAllNodesResponse
  | ExportNodeSVGsResponse
  | NodeChangedResponse
  | SelectionChangedResponse
  | SetPenpotPageResponse
  | ApplyPenpotChangesResponse
  | RequestPenpotPageResponse;


// Union of all message types
export type Message = Request | Response;

// =================
// TYPE UTILITIES
// =================

// Request-to-Response type mapping utility
export type RequestToResponseMap = {
  [StoreMessageType.STATE_UPDATE]: {
    request: StoreStateUpdateRequest;
    response: StoreStateUpdateResponse;
  };
  [StoreMessageType.GET_STATE]: {
    request: StoreGetStateRequest;
    response: StoreGetStateResponse;
  };
  [OperationMessageType.DRAW_RECTANGLE]: {
    request: DrawRectangleRequest;
    response: DrawRectangleResponse;
  };
  [OperationMessageType.CHANGE_COLOR]: {
    request: ChangeColorRequest;
    response: ChangeColorResponse;
  };
  [OperationMessageType.CREATE_FRAME]: {
    request: CreateFrameRequest;
    response: CreateFrameResponse;
  };
  [OperationMessageType.COMPLETE]: {
    request: CompleteRequest;
    response: CompleteResponse;
  };
  [OperationMessageType.RESIZE_ELEMENT]: {
    request: ResizeElementRequest;
    response: ResizeElementResponse;
  };
  [OperationMessageType.GET_NODES_UNDER_UI]: {
    request: GetNodesUnderUIRequest;
    response: GetNodesUnderUIResponse;
  };
  [SystemMessageType.ERROR]: {
    request: ErrorRequest;
    response: ErrorResponse;
  };
  [SystemMessageType.WARNING]: {
    request: WarningRequest;
    response: WarningResponse;
  };
  [SystemMessageType.INFO]: {
    request: InfoRequest;
    response: InfoResponse;
  };
  [SystemMessageType.PLUGIN_READY]: {
    request: PluginReadyRequest;
    response: PluginReadyResponse;
  };
  [SystemMessageType.WORKER_TEST]: {
    request: WorkerTestRequest;
    response: WorkerTestResponse;
  };
  [SystemMessageType.RESIZE]: {
    request: ResizeRequest;
    response: ResizeResponse;
  };
  [SystemMessageType.GET_POSITION]: {
    request: GetPositionRequest;
    response: GetPositionResponse;
  };
  [SystemMessageType.SYNC_CANVAS]: {
    request: SyncCanvasRequest;
    response: SyncCanvasResponse;
  };
  [SystemMessageType.UPDATE_VIEWPORT]: {
    request: UpdateViewportRequest;
    response: UpdateViewportResponse;
  };
  [SystemMessageType.GET_VIEWPORT_BOUNDS]: {
    request: GetViewportBoundsRequest;
    response: GetViewportBoundsResponse;
  };
  [SystemMessageType.GET_ALL_NODES]: {
    request: GetAllNodesRequest;
    response: GetAllNodesResponse;
  };
  [SystemMessageType.EXPORT_NODE_SVGS]: {
    request: ExportNodeSVGsRequest;
    response: ExportNodeSVGsResponse;
  };
  [SystemMessageType.NODE_CHANGED]: {
    request: NodeChangedRequest;
    response: NodeChangedResponse;
  };
  [SystemMessageType.SELECTION_CHANGED]: {
    request: SelectionChangedRequest;
    response: SelectionChangedResponse;
  };
  [SystemMessageType.SET_PENPOT_PAGE]: {
    request: SetPenpotPageRequest;
    response: SetPenpotPageResponse;
  };
  [SystemMessageType.APPLY_PENPOT_CHANGES]: {
    request: ApplyPenpotChangesRequest;
    response: ApplyPenpotChangesResponse;
  };
  [SystemMessageType.REQUEST_PENPOT_PAGE]: {
    request: RequestPenpotPageRequest;
    response: RequestPenpotPageResponse;
  };
};

// Utility type to extract request type from message type
export type ExtractRequestType<T extends keyof RequestToResponseMap> = 
  RequestToResponseMap[T]['request'];

// Utility type to extract response type from message type
export type ExtractResponseType<T extends keyof RequestToResponseMap> = 
  RequestToResponseMap[T]['response'];

// Utility type to extract result type from response
export type ExtractResultType<T extends Response> = 
  T extends { result: infer R } ? R : never;

// Enhanced type-safe message creator utilities
export type MessageRequestCreator<T extends keyof RequestToResponseMap> = 
  Omit<ExtractRequestType<T>, 'id' | 'timestamp' | 'source'>;

export type MessageResponseResult<T extends keyof RequestToResponseMap> = 
  ExtractResultType<ExtractResponseType<T>>;

// Conditional type for strict payload validation
export type ValidatedPayload<T extends Request> = 
  T extends { payload: infer P } ? P : never;

// Type guard factory for specific message types
export function createMessageTypeGuard<T extends keyof RequestToResponseMap>(
  category: MessageCategory,
  type: T
) {
  return (message: Message): message is ExtractRequestType<T> => {
    return isRequest(message) && 
           message.category === category && 
           message.type === type;
  };
}

// Enhanced error types for better error handling
export interface TypedError<T = any> extends Error {
  code?: string;
  context?: T;
  timestamp?: number;
}

export class MessageValidationError extends Error implements TypedError {
  code = 'MESSAGE_VALIDATION_ERROR';
  timestamp: number;
  
  constructor(message: string, public context?: any) {
    super(message);
    this.name = 'MessageValidationError';
    this.timestamp = Math.floor(Date.now() / 1000);
  }
}

export class HandlerNotFoundError extends Error implements TypedError {
  code = 'HANDLER_NOT_FOUND_ERROR';
  timestamp: number;
  
  constructor(category: MessageCategory, type: string, public context?: any) {
    super(`No handler found for ${category}:${type}`);
    this.name = 'HandlerNotFoundError';
    this.timestamp = Math.floor(Date.now() / 1000);
  }
}

// Type guards for request/response identification
export function isRequest(message: Message): message is Request {
  return !('success' in message);
}

export function isResponse(message: Message): message is Response {
  return 'success' in message;
}

// Enhanced type guards with specific type checking
export function isStoreMessage(message: Message): message is StoreStateUpdateRequest | StoreGetStateRequest {
  return message.category === MessageCategory.STORE;
}

export function isOperationMessage(message: Message): message is 
  DrawRectangleRequest | ChangeColorRequest | CreateFrameRequest | CompleteRequest | ResizeElementRequest {
  return message.category === MessageCategory.OPERATION;
}

export function isSystemMessage(message: Message): message is 
  ErrorRequest | WarningRequest | InfoRequest | PluginReadyRequest | WorkerTestRequest {
  return message.category === MessageCategory.SYSTEM;
}
