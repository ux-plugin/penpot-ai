import type { Node } from '@xyflow/react';

/**
 * Interface for Figma Frame Node data
 */
export interface FrameNodeData extends Record<string, unknown> {
  label: string;
  locked?: boolean;
  visible?: boolean;
  opacity?: number;
  rotation?: number;
  name?: string;
  nodeType?: 'FRAME' | 'COMPONENT' | 'COMPONENT_SET';
  
  // Dimensions
  width?: number;
  height?: number;
  
  // Layout properties
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  layoutAlign?: 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'INHERIT';
  layoutGrow?: number;
  primaryAxisSizingMode?: 'FIXED' | 'AUTO';
  counterAxisSizingMode?: 'FIXED' | 'AUTO';
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  itemSpacing?: number;
  
  // Style properties - removed undefined to match Figma's types exactly
  fills?: readonly Paint[];
  strokes?: readonly Paint[];
  strokeWeight?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  cornerRadius?: {
    topLeft: number;
    topRight: number;
    bottomLeft: number;
    bottomRight: number;
  };
  blendMode?: BlendMode;
  
  // Style IDs - removed undefined to match Figma's types exactly
  fillStyleId?: string | typeof figma.mixed;
  strokeStyleId?: string;
  effectStyleId?: string;
  
  // Effects
  effects?: readonly Effect[];
  
  // Children - recursively nested nodes
  children?: Array<ReactFlowFrameNodeType | TextNodeType>;

  // SVG vectors
  svg?: string | Uint8Array;
  svgElement?: SVGElement;
}

/**
 * Type for a React Flow Node created from a Figma FrameNode, ComponentNode, or ComponentSetNode.
 */
export type ReactFlowFrameNodeType = Node<FrameNodeData, 'figmaNode'>;

/**
 * Interface for a styled text segment within a TextNode
 */
export interface StyledTextSegment {
  characters: string;
  start: number;
  end: number;
  
  // Text style properties
  fontSize: number;
  fontName: FontName;
  fontWeight: number;
  textDecoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  textDecorationStyle: 'SOLID' | 'WAVY' | 'DOTTED' | null;
  textDecorationOffset: { value: number; unit: 'PIXELS' | 'PERCENT' } | { unit: 'AUTO' } | null;
  textDecorationThickness: { value: number; unit: 'PIXELS' | 'PERCENT' } | { unit: 'AUTO' } | null;
  textDecorationColor: { value: Paint } | { value: 'AUTO' } | null;
  textDecorationSkipInk: boolean | null;
  textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE' | 'SMALL_CAPS' | 'SMALL_CAPS_FORCED';
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  fills: readonly Paint[];
  textStyleId: string;
  fillStyleId: string;
  listOptions: { type: 'ORDERED' | 'UNORDERED' | 'NONE' };
  listSpacing: number;
  indentation: number;
  paragraphIndent: number;
  paragraphSpacing: number;
  hyperlink: { type: 'URL' | 'NODE'; value: string } | null;
  openTypeFeatures: { readonly [feature: string]: boolean };
  boundVariables?: {
    [field: string]: any;
  };
  textStyleOverrides: Array<{ type: 'SEMANTIC_ITALIC' | 'SEMANTIC_WEIGHT' | 'HYPERLINK' | 'TEXT_DECORATION' }>;
}

/**
 * Interface for Figma Text Node data
 */
export interface TextNodeData extends Record<string, unknown> {
  label: string;
  locked?: boolean;
  visible?: boolean;
  opacity?: number;
  rotation?: number;
  text: string;
  name?: string;
  
  // Node-level style properties (not segment-specific)
  strokes?: readonly Paint[];
  strokeWeight?: number
  blendMode?: BlendMode;
  
  // Node-level style IDs
  strokeStyleId?: string;
  effectStyleId?: string;
  
  // Effects
  effects?: readonly Effect[];
  
  // Text box alignment properties (not segment-specific)
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
  
  // Text content
  characters?: string;
  
  // Styled text segments - each segment has its own styles
  segments?: StyledTextSegment[];

  // SVG vectors
  svg?: string;
  svgElement?: SVGElement;
}

/**
 * Type for a React Flow Node created from a Figma TextNode.
 */
export type TextNodeType = Node<TextNodeData, 'textNode'>;
