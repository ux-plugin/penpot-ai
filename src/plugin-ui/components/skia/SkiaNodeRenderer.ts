/**
 * SkiaNodeRenderer
 *
 * Renders design nodes using CanvasKit (Skia).
 * Handles fills, strokes, corner radius, opacity, rotation, and blend modes.
 * Preserves hierarchy with proper z-ordering and clipping.
 */

import type { CanvasKit, Canvas, Path, EmbindEnumEntity } from "canvaskit-wasm";
import type { DesignNode } from "@shared-types/types";
import type { FrameNodeData } from "@components/nodes/node.types";
import {
  computeAbsolutePositions,
  type AbsoluteNode,
} from "@/plugin-ui/utils/pixiNodeRenderer";

/**
 * Color interface from Figma
 */
interface FigmaColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Paint interface from Figma
 */
interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
}

/**
 * Convert Figma color (0-1 range) to CanvasKit color
 */
export function figmaColorToSkia(
  canvasKit: CanvasKit,
  color: FigmaColor,
  alpha: number = 1,
): Float32Array {
  return canvasKit.Color4f(color.r, color.g, color.b, alpha);
}

/**
 * Figma blend mode to CanvasKit blend mode mapping
 */
export function figmaToSkiaBlendMode(
  canvasKit: CanvasKit,
  blendMode: string,
): EmbindEnumEntity {
  const blendModeMap: Record<string, EmbindEnumEntity> = {
    PASS_THROUGH: canvasKit.BlendMode.SrcOver,
    NORMAL: canvasKit.BlendMode.SrcOver,
    DARKEN: canvasKit.BlendMode.Darken,
    MULTIPLY: canvasKit.BlendMode.Multiply,
    COLOR_BURN: canvasKit.BlendMode.ColorBurn,
    LIGHTEN: canvasKit.BlendMode.Lighten,
    SCREEN: canvasKit.BlendMode.Screen,
    COLOR_DODGE: canvasKit.BlendMode.ColorDodge,
    OVERLAY: canvasKit.BlendMode.Overlay,
    SOFT_LIGHT: canvasKit.BlendMode.SoftLight,
    HARD_LIGHT: canvasKit.BlendMode.HardLight,
    DIFFERENCE: canvasKit.BlendMode.Difference,
    EXCLUSION: canvasKit.BlendMode.Exclusion,
    HUE: canvasKit.BlendMode.Hue,
    SATURATION: canvasKit.BlendMode.Saturation,
    COLOR: canvasKit.BlendMode.Color,
    LUMINOSITY: canvasKit.BlendMode.Luminosity,
  };

  return blendModeMap[blendMode] ?? canvasKit.BlendMode.SrcOver;
}

/**
 * Create a rounded rectangle path with per-corner radius
 */
export function createRoundedRectPath(
  canvasKit: CanvasKit,
  x: number,
  y: number,
  width: number,
  height: number,
  topLeft: number,
  topRight: number,
  bottomRight: number,
  bottomLeft: number,
): Path {
  const path = new canvasKit.Path();

  // Clamp radii to not exceed half of width/height
  const maxRadius = Math.min(width / 2, height / 2);
  topLeft = Math.min(topLeft, maxRadius);
  topRight = Math.min(topRight, maxRadius);
  bottomRight = Math.min(bottomRight, maxRadius);
  bottomLeft = Math.min(bottomLeft, maxRadius);

  // Check if all corners are the same
  const isUniform =
    topLeft === topRight &&
    topRight === bottomRight &&
    bottomRight === bottomLeft;

  if (isUniform && topLeft === 0) {
    // Simple rectangle
    path.addRect(canvasKit.XYWHRect(x, y, width, height));
  } else if (isUniform) {
    // Uniform rounded rectangle
    path.addRRect(
      canvasKit.RRectXY(
        canvasKit.XYWHRect(x, y, width, height),
        topLeft,
        topLeft,
      ),
    );
  } else {
    // Per-corner radius - build path manually
    path.moveTo(x + topLeft, y);
    path.lineTo(x + width - topRight, y);
    if (topRight > 0) {
      path.arcToTangent(x + width, y, x + width, y + topRight, topRight);
    }
    path.lineTo(x + width, y + height - bottomRight);
    if (bottomRight > 0) {
      path.arcToTangent(
        x + width,
        y + height,
        x + width - bottomRight,
        y + height,
        bottomRight,
      );
    }
    path.lineTo(x + bottomLeft, y + height);
    if (bottomLeft > 0) {
      path.arcToTangent(x, y + height, x, y + height - bottomLeft, bottomLeft);
    }
    path.lineTo(x, y + topLeft);
    if (topLeft > 0) {
      path.arcToTangent(x, y, x + topLeft, y, topLeft);
    }
    path.close();
  }

  return path;
}

/**
 * Draw a single node on the canvas
 */
export function drawNode(
  canvasKit: CanvasKit,
  canvas: Canvas,
  node: AbsoluteNode,
): void {
  const { width, height, data, absoluteX, absoluteY } = node;
  const frameData = data as FrameNodeData;

  // Get corner radius
  const cr = frameData.cornerRadius || {
    topLeft: 0,
    topRight: 0,
    bottomRight: 0,
    bottomLeft: 0,
  };

  // Create path
  const path = createRoundedRectPath(
    canvasKit,
    absoluteX,
    absoluteY,
    width,
    height,
    cr.topLeft,
    cr.topRight,
    cr.bottomRight,
    cr.bottomLeft,
  );

  // Apply rotation if needed
  if (data.rotation && data.rotation !== 0) {
    const centerX = absoluteX + width / 2;
    const centerY = absoluteY + height / 2;
    canvas.save();
    canvas.rotate((data.rotation * Math.PI) / 180, centerX, centerY);
  }

  // Draw fill
  if (frameData.fills && frameData.fills.length > 0) {
    const fill = frameData.fills[0] as FigmaPaint;
    if (fill.visible !== false && fill.type === "SOLID" && fill.color) {
      const paint = new canvasKit.Paint();
      paint.setStyle(canvasKit.PaintStyle.Fill);
      paint.setAntiAlias(true);

      const alpha = (fill.opacity ?? 1) * (data.opacity ?? 1);
      paint.setColor(figmaColorToSkia(canvasKit, fill.color, alpha));

      // Apply blend mode
      if (data.blendMode && typeof data.blendMode === "string") {
        paint.setBlendMode(figmaToSkiaBlendMode(canvasKit, data.blendMode));
      }

      canvas.drawPath(path, paint);
      paint.delete();
    }
  }

  // Draw stroke
  if (
    frameData.strokes &&
    frameData.strokes.length > 0 &&
    frameData.strokeWeight
  ) {
    const stroke = frameData.strokes[0] as FigmaPaint;
    if (stroke.visible !== false && stroke.type === "SOLID" && stroke.color) {
      const paint = new canvasKit.Paint();
      paint.setStyle(canvasKit.PaintStyle.Stroke);
      paint.setAntiAlias(true);

      const strokeWidth = frameData.strokeWeight.top || 1;
      paint.setStrokeWidth(strokeWidth);

      const alpha = (stroke.opacity ?? 1) * (data.opacity ?? 1);
      paint.setColor(figmaColorToSkia(canvasKit, stroke.color, alpha));

      // Apply blend mode
      if (data.blendMode && typeof data.blendMode === "string") {
        paint.setBlendMode(figmaToSkiaBlendMode(canvasKit, data.blendMode));
      }

      canvas.drawPath(path, paint);
      paint.delete();
    }
  }

  // Restore rotation
  if (data.rotation && data.rotation !== 0) {
    canvas.restore();
  }

  // Clean up path
  path.delete();
}

/**
 * Node hierarchy tree for efficient rendering
 */
interface NodeTree {
  node: AbsoluteNode;
  children: NodeTree[];
}

/**
 * Build a tree structure from flat nodes list
 */
function buildNodeTree(nodes: AbsoluteNode[]): NodeTree[] {
  const nodeMap = new Map<string, AbsoluteNode>();
  const childrenMap = new Map<string, AbsoluteNode[]>();

  // Build lookup maps
  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (node.parentId) {
      if (!childrenMap.has(node.parentId)) {
        childrenMap.set(node.parentId, []);
      }
      childrenMap.get(node.parentId)!.push(node);
    }
  }

  // Build tree from root nodes
  function buildTree(node: AbsoluteNode): NodeTree {
    const children = childrenMap.get(node.id) || [];
    return {
      node,
      children: children.map(buildTree),
    };
  }

  // Find root nodes (no parent)
  const roots = nodes.filter((n) => !n.parentId);
  return roots.map(buildTree);
}

/**
 * Render a node tree recursively with proper hierarchy
 */
function renderNodeTree(
  canvasKit: CanvasKit,
  canvas: Canvas,
  tree: NodeTree,
): void {
  const { node, children } = tree;
  const frameData = node.data as FrameNodeData;

  // Save canvas state for this subtree
  canvas.save();

  // Apply clipping if frame clips content
  if (frameData.clipsContent) {
    const clipPath = createRoundedRectPath(
      canvasKit,
      node.absoluteX,
      node.absoluteY,
      node.width,
      node.height,
      frameData.cornerRadius?.topLeft || 0,
      frameData.cornerRadius?.topRight || 0,
      frameData.cornerRadius?.bottomRight || 0,
      frameData.cornerRadius?.bottomLeft || 0,
    );
    canvas.clipPath(clipPath, canvasKit.ClipOp.Intersect, true);
    clipPath.delete();
  }

  // Draw the node itself
  drawNode(canvasKit, canvas, node);

  // Recursively render children (depth-first for correct z-order)
  for (const child of children) {
    renderNodeTree(canvasKit, canvas, child);
  }

  // Restore canvas state
  canvas.restore();
}

/**
 * Render all nodes with hierarchy preservation
 */
export function renderAllNodes(
  canvasKit: CanvasKit,
  canvas: Canvas,
  nodes: DesignNode[],
): void {
  // Compute absolute positions
  const absoluteNodes = computeAbsolutePositions(nodes);

  // Build tree structure
  const trees = buildNodeTree(absoluteNodes);

  // Render each root tree
  for (const tree of trees) {
    renderNodeTree(canvasKit, canvas, tree);
  }
}

/**
 * Render pre-computed absolute nodes (more efficient for repeated renders)
 */
export function renderAbsoluteNodes(
  canvasKit: CanvasKit,
  canvas: Canvas,
  absoluteNodes: AbsoluteNode[],
): void {
  // Build tree structure
  const trees = buildNodeTree(absoluteNodes);

  // Render each root tree
  for (const tree of trees) {
    renderNodeTree(canvasKit, canvas, tree);
  }
}

/**
 * Draw a simple bounding box (for debugging or selection)
 */
export function drawBoundingBox(
  canvasKit: CanvasKit,
  canvas: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
  color?: Float32Array,
): void {
  const paint = new canvasKit.Paint();
  paint.setStyle(canvasKit.PaintStyle.Stroke);
  paint.setAntiAlias(true);
  paint.setStrokeWidth(1);
  paint.setColor(color || canvasKit.Color4f(0.23, 0.51, 0.97, 0.5)); // Blue-ish

  canvas.drawRect(canvasKit.XYWHRect(x, y, width, height), paint);
  paint.delete();
}

export { type AbsoluteNode };
