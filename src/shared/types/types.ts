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

export interface FrameProperties {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;

  // Position and size
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;

  // Layout properties
  layoutMode: string;
  layoutAlign: string;
  layoutGrow: number;
  primaryAxisSizingMode: string;
  counterAxisSizingMode: string;
  primaryAxisAlignItems: string;
  counterAxisAlignItems: string;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  itemSpacing: number;

  // Style properties
  fills: symbol | ReadonlyArray<Paint>;
  strokes: ReadonlyArray<Paint>;
  strokeWeight: number | symbol;
  strokeAlign: string;
  cornerRadius: number | PluginAPI["mixed"];
  opacity: number;
  blendMode: BlendMode;

  // Style IDs
  fillStyleId: string | symbol;
  strokeStyleId: string;
  effectStyleId: string;

  // Effects and other styles
  effects: ReadonlyArray<Effect>;

  // Children
  children: FrameProperties[];
}

export interface TextProperties {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;

  // Position and size
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;

  // Text content
  characters: string;
  
  // Text style properties
  fontSize: number | symbol;
  fontName: FontName | symbol;
  textAlignHorizontal: string;
  textAlignVertical: string;
  letterSpacing: LetterSpacing | symbol;
  lineHeight: LineHeight | symbol;
  textCase: TextCase | symbol;
  textDecoration: TextDecoration | symbol;

  // Style properties
  fills: symbol | ReadonlyArray<Paint>;
  strokes: ReadonlyArray<Paint>;
  strokeWeight: number | symbol;
  opacity: number;
  blendMode: BlendMode;

  // Style IDs
  fillStyleId: string | symbol;
  strokeStyleId: string;
  effectStyleId: string;
  textStyleId: string | symbol;

  // Effects
  effects: ReadonlyArray<Effect>;
}