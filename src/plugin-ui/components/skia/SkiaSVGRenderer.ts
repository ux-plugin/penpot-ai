/**
 * SkiaSVGRenderer
 *
 * Renders SVG as true vector graphics using CanvasKit.
 * Unlike bitmap-based approaches, this maintains crisp rendering at any zoom level.
 */

import type { CanvasKit, Canvas, SVGDOM } from "canvaskit-wasm";
import type { AbsoluteNode } from "@/plugin-ui/utils/nodeRendererUtils";

/**
 * SVG cache to avoid re-parsing the same SVG multiple times
 */
const svgCache = new Map<string, SVGDOM>();

/**
 * Parse SVG string and cache the result
 * Note: CanvasKit's SVG support requires the full CanvasKit build with Skia's SVG module
 */
export function parseSVG(
  canvasKit: CanvasKit,
  svgString: string,
  cacheKey?: string,
): SVGDOM | null {
  const key = cacheKey || svgString.substring(0, 100);

  if (svgCache.has(key)) {
    return svgCache.get(key) || null;
  }

  // Use CanvasKit's SVG DOM support
  // Note: This requires CanvasKit to be built with SVG support
  try {
    const svgDom = canvasKit.MakeSVGFromDOM(svgString);
    if (svgDom) {
      svgCache.set(key, svgDom);
      return svgDom;
    }
  } catch (error) {
    console.warn("[SkiaSVGRenderer] MakeSVGFromDOM failed:", error);
  }

  return null;
}

/**
 * Render an SVG string on the canvas as true vector graphics
 */
export function renderSVG(
  canvasKit: CanvasKit,
  canvas: Canvas,
  svgString: string,
  x: number,
  y: number,
  width: number,
  height: number,
  opacity: number = 1,
): boolean {
  // Parse SVG
  const svgDom = parseSVG(canvasKit, svgString);

  if (!svgDom) {
    // Fallback: draw a placeholder rectangle
    const paint = new canvasKit.Paint();
    paint.setStyle(canvasKit.PaintStyle.Fill);
    paint.setColor(canvasKit.Color4f(0.9, 0.9, 0.9, opacity * 0.5));
    canvas.drawRect(canvasKit.XYWHRect(x, y, width, height), paint);
    paint.delete();
    return false;
  }

  canvas.save();

  // Translate to position
  canvas.translate(x, y);

  // Set container size for the SVG
  svgDom.setContainerSize(width, height);

  // Apply opacity via saveLayer if opacity is less than 1
  if (opacity < 1) {
    const opacityPaint = new canvasKit.Paint();
    opacityPaint.setAlphaf(opacity);
    canvas.saveLayer(opacityPaint, canvasKit.XYWHRect(0, 0, width, height));
    opacityPaint.delete();
  }

  // Render the SVG
  svgDom.render(canvas);

  // Restore opacity layer if applied
  if (opacity < 1) {
    canvas.restore();
  }

  canvas.restore();
  return true;
}

/**
 * Render an SVG node
 */
export function renderSVGNode(
  canvasKit: CanvasKit,
  canvas: Canvas,
  node: AbsoluteNode,
): boolean {
  const { absoluteX, absoluteY, width, height, data } = node;

  if (!data.svg) {
    return false;
  }

  return renderSVG(
    canvasKit,
    canvas,
    data.svg,
    absoluteX,
    absoluteY,
    width,
    height,
    data.opacity ?? 1,
  );
}

/**
 * Clear the SVG cache (useful for memory management)
 */
export function clearSVGCache(): void {
  // Delete any CanvasKit SVGDOM objects before clearing
  for (const svgDom of svgCache.values()) {
    if (svgDom?.delete) {
      svgDom.delete();
    }
  }
  svgCache.clear();
}
