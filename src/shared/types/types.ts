import { ReactFlowFrameNodeType, TextNodeType, SVGNodeType } from "@components/nodes";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | Array<JsonValue>;

export enum MessageType {
  complete,
  storageSave,
  storageRemove,
  storageGet,
  close,
}

// Base interfaces for request and response
export interface BaseRequest {
  id: string;
  type: MessageType;
}

export interface BaseResponse {
  id: string;
  result: unknown;
  error?: string;
}

export interface CompletionRequest extends BaseRequest {
  type: MessageType.complete;
  object: Partial<FrameNode> & { parent: string; fillStyleId: string };
}

export interface CompletionResponse extends BaseResponse {
  type: MessageType.complete;
  result: boolean;
}

export interface StorageSaveRequest extends BaseRequest {
  type: MessageType.storageSave;
  key: string;
  value: JsonValue;
}

export interface StorageSaveResponse extends BaseResponse {
  type: MessageType.storageSave;
  result: boolean;
}

export interface StorageRemoveRequest extends BaseRequest {
  type: MessageType.storageRemove;
  key: string;
}

export interface StorageRemoveResponse extends BaseResponse {
  type: MessageType.storageRemove;
  result: boolean;
}

// Storage Gets Message Types
export interface StorageGetRequest extends BaseRequest {
  type: MessageType.storageGet;
  key: string;
}

export interface StorageGetResponse<TRes extends JsonValue>
  extends BaseResponse {
  type: MessageType.storageGet;
  result: TRes;
}

// Close Message Types
export interface CloseRequest extends BaseRequest {
  type: MessageType.close;
}

export interface CloseResponse extends BaseResponse {
  type: MessageType.close;
  result: boolean;
}

export type Request =
  | CompletionRequest
  | StorageSaveRequest
  | StorageRemoveRequest
  | StorageGetRequest
  | CloseRequest;


export type DesignNode = ReactFlowFrameNodeType | TextNodeType | SVGNodeType;
export type FrameNodeProperties = ReactFlowFrameNodeType;
export type TextNodeProperties = TextNodeType;