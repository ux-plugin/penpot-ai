import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle as HandleComponent, Position as PositionEnum } from '@xyflow/react';
import type { ReactFlowFrameNodeType } from "./node.types";
import {
  convertBlendModeToCSS,
  convertEffectsToCSS,
  convertPaintToCSS,
} from "@utils/figmaStyleConversions.tsx";

/**
 * Constants for node styling
 */
const LOCKED_OPACITY = 0.5;
const HIDDEN_OPACITY = 0.3;

const NODE_TYPE_STYLES = {
  FRAME: {
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  COMPONENT: {
    borderColor: '#8b5cf6',
    backgroundColor: '#f5f3ff',
  },
  COMPONENT_SET: {
    borderColor: '#a855f7',
    backgroundColor: '#faf5ff',
  },
} as const;

/**
 * Converts Figma corner radius to CSS border-radius
 */
const convertCornerRadiusToCSS = (cornerRadius?: { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number }): string | undefined => {
  if (!cornerRadius) return undefined;
  
  const { topLeft, topRight, bottomRight, bottomLeft } = cornerRadius;
  
  // If all corners are the same, return a single value
  if (topLeft === topRight && topRight === bottomRight && bottomRight === bottomLeft) {
    return `${topLeft}px`;
  }
  
  // Return individual corner values (top-left, top-right, bottom-right, bottom-left)
  return `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`;
};

/**
 * Converts Figma stroke weight to CSS border width
 * Handles strokeAlign by adjusting the border rendering
 */
const convertStrokeWeightToCSS = (
  strokeWeight?: { top: number; right: number; bottom: number; left: number },
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER'
): { borderWidth?: string; boxSizing?: 'border-box' | 'content-box' } => {
  if (!strokeWeight) return {};
  
  const { top, right, bottom, left } = strokeWeight;
  
  // For simplicity, we'll use border-box for INSIDE (default CSS behavior)
  // OUTSIDE would need additional wrapping or box-shadow technique
  // CENTER is close to default border behavior
  const boxSizing = strokeAlign === 'INSIDE' ? 'border-box' : 'border-box';
  
  // If all sides are the same, return a single value
  if (top === right && right === bottom && bottom === left) {
    return { borderWidth: `${top}px`, boxSizing };
  }
  
  // Return individual border widths (top, right, bottom, left)
  return { 
    borderWidth: `${top}px ${right}px ${bottom}px ${left}px`,
    boxSizing
  };
};

/**
 * Converts Figma layout mode to CSS display and flex properties
 */
const convertLayoutModeToCSS = (
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID',
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN',
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE',
  itemSpacing?: number
): { 
  display?: string; 
  flexDirection?: 'row' | 'column'; 
  justifyContent?: string; 
  alignItems?: string;
  gap?: string;
} => {
  if (!layoutMode || layoutMode === 'NONE') {
    return {};
  }
  
  const result: {
    display?: string;
    flexDirection?: 'row' | 'column';
    justifyContent?: string;
    alignItems?: string;
    gap?: string;
  } = {};
  
  if (layoutMode === 'HORIZONTAL') {
    result.display = 'flex';
    result.flexDirection = 'row';
  } else if (layoutMode === 'VERTICAL') {
    result.display = 'flex';
    result.flexDirection = 'column';
  } else if (layoutMode === 'GRID') {
    result.display = 'grid';
  }
  
  // Convert primary axis alignment (justify-content for flex)
  if (primaryAxisAlignItems) {
    const alignMap: Record<string, string> = {
      'MIN': 'flex-start',
      'CENTER': 'center',
      'MAX': 'flex-end',
      'SPACE_BETWEEN': 'space-between',
    };
    result.justifyContent = alignMap[primaryAxisAlignItems];
  }
  
  // Convert counter axis alignment (align-items for flex)
  if (counterAxisAlignItems) {
    const alignMap: Record<string, string> = {
      'MIN': 'flex-start',
      'CENTER': 'center',
      'MAX': 'flex-end',
      'BASELINE': 'baseline',
    };
    result.alignItems = alignMap[counterAxisAlignItems];
  }
  
  // Item spacing becomes gap
  if (itemSpacing !== undefined) {
    result.gap = `${itemSpacing}px`;
  }
  
  return result;
};

/**
 * Converts individual padding values to CSS padding
 */
const convertPaddingToCSS = (
  paddingTop?: number,
  paddingRight?: number,
  paddingBottom?: number,
  paddingLeft?: number
): string | undefined => {
  // If no padding values provided, return undefined
  if (paddingTop === undefined && paddingRight === undefined && 
      paddingBottom === undefined && paddingLeft === undefined) {
    return undefined;
  }
  
  const top = paddingTop ?? 0;
  const right = paddingRight ?? 0;
  const bottom = paddingBottom ?? 0;
  const left = paddingLeft ?? 0;
  
  // If all sides are the same, return a single value
  if (top === right && right === bottom && bottom === left) {
    return `${top}px`;
  }
  
  // Return individual padding values (top, right, bottom, left)
  return `${top}px ${right}px ${bottom}px ${left}px`;
};

/**
 * React Flow Frame Node Component
 * 
 * A memoized React component that renders a Figma frame, component, or component set as a React Flow node.
 * Supports all FrameNodeData properties including:
 * - Basic: locked, visible, opacity, rotation, name, label, width, height, nodeType
 * - Fill/Background: fills, fillStyleId
 * - Stroke/Border: strokes, strokeWeight, strokeAlign, strokeStyleId
 * - Corner radius: cornerRadius (individual corners)
 * - Visual effects: blendMode, effects, effectStyleId
 * - Layout: layoutMode, alignments, padding, itemSpacing
 * 
 * Different node types (FRAME, COMPONENT, COMPONENT_SET) are visually distinguished by border and background colors.
 * 
 * @param props - NodeProps containing node data and dimensions
 * @returns A styled node component with handles for connections
 */
export const ReactFlowFrameNode = memo((props: NodeProps<ReactFlowFrameNodeType>) => {
  const { data, width = 150, positionAbsoluteX, positionAbsoluteY } = props;
  
  // Basic properties
  const locked = data?.locked ?? false;
  const visible = data?.visible ?? true;
  const baseOpacity = data?.opacity ?? 1;
  const rotation = data?.rotation ?? 0;
  const label = data?.label ?? '';
  const name = data?.name ?? label;
  const nodeType = data?.nodeType ?? 'FRAME';
  
  // Dimensions
  const nodeWidth = data?.width ?? width;
  const nodeHeight = data?.height;
  
  // Get type-specific styling
  const typeStyles = NODE_TYPE_STYLES[nodeType];
  
  // Fill/Background properties - use type-specific background if no custom fills
  const backgroundColor = data?.fills?.[0] ? convertPaintToCSS(data.fills[0]) : typeStyles.backgroundColor;
  
  // Stroke/Border properties - use type-specific border color if no custom strokes
  const strokeColor = data?.strokes?.[0] ? convertPaintToCSS(data.strokes[0]) : typeStyles.borderColor;
  const { borderWidth, boxSizing } = convertStrokeWeightToCSS(data?.strokeWeight, data?.strokeAlign);
  const borderStyle = data?.strokes && data.strokes.length > 0 ? 'solid' : 'solid';
  
  // Corner radius
  const borderRadius = convertCornerRadiusToCSS(data?.cornerRadius) ?? '8px';
  
  // Visual effects
  const blendMode = convertBlendModeToCSS(data?.blendMode);
  const { boxShadow, filter } = convertEffectsToCSS(data?.effects);
  
  // Layout properties
  const layoutStyles = convertLayoutModeToCSS(
    data?.layoutMode,
    data?.primaryAxisAlignItems,
    data?.counterAxisAlignItems,
    data?.itemSpacing
  );
  
  // Padding
  const padding = convertPaddingToCSS(
    data?.paddingTop,
    data?.paddingRight,
    data?.paddingBottom,
    data?.paddingLeft
  ) ?? '12px 16px';
  
  // Calculate final opacity based on visibility and locked state
  const finalOpacity = !visible ? HIDDEN_OPACITY : (locked ? LOCKED_OPACITY : baseOpacity);

  console.log(`[ReactFlowFrameNode] Rendering ${nodeType} node "${label}" at position:`, {
    x: positionAbsoluteX,
    y: positionAbsoluteY,
    label,
    name,
    nodeType,
    visible,
    locked,
    opacity: finalOpacity,
    rotation,
    layoutMode: data?.layoutMode,
    width: nodeWidth,
    height: nodeHeight,
  });

  return (
    <div
      className="figma-node"
      style={{
        backgroundColor,
        border: `${borderWidth ?? '2px'} ${borderStyle} ${strokeColor}`,
        borderRadius,
        padding,
        minWidth: nodeWidth,
        width: nodeWidth,
        height: nodeHeight,
        boxShadow: boxShadow ?? '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
        opacity: finalOpacity,
        transform: `rotate(${rotation}deg)`,
        mixBlendMode: blendMode as any,
        filter: filter,
        pointerEvents: visible ? 'auto' : 'none',
        boxSizing: boxSizing ?? 'border-box',
        position: 'relative',
        ...layoutStyles,
      }}
      data-fill-style-id={typeof data?.fillStyleId === 'string' ? data.fillStyleId : undefined}
      data-stroke-style-id={data?.strokeStyleId}
      data-effect-style-id={data?.effectStyleId}
    >
      {nodeType !== 'FRAME' && (
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4 }}>
          {nodeType === 'COMPONENT' ? '◆ Component' : '◆ Component Set'}
        </div>
      )}
      <HandleComponent
        type="target"
        position={PositionEnum.Top}
        style={{ opacity: 0 }}
      />
      <HandleComponent
        type="source"
        position={PositionEnum.Bottom}
        style={{ opacity: 0 }}
      />
    </div>
  );
});

ReactFlowFrameNode.displayName = 'ReactFlowFrameNode';
