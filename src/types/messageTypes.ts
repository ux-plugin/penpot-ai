// Pure Request/Response message type system for scalable communication between UI and code.ts
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
  COMPLETE = 'complete'
}

export enum SystemMessageType {
  ERROR = 'error',
  WARNING = 'warning',
  INFO = 'info',
  PLUGIN_READY = 'plugin_ready',
  WORKER_TEST = 'worker_test'
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
    payload: any;
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
  | ErrorRequest
  | WarningRequest
  | InfoRequest
  | PluginReadyRequest
  | WorkerTestRequest;

// All response types
export type Response = 
  | StoreStateUpdateResponse
  | StoreGetStateResponse
  | DrawRectangleResponse
  | ChangeColorResponse
  | CreateFrameResponse
  | CompleteResponse
  | ResizeElementResponse
  | ErrorResponse
  | WarningResponse
  | InfoResponse
  | PluginReadyResponse
  | WorkerTestResponse;

// Union of all message types
export type Message = Request | Response;

// Type guards for request/response identification
export function isRequest(message: Message): message is Request {
  return !('success' in message);
}

export function isResponse(message: Message): message is Response {
  return 'success' in message;
}