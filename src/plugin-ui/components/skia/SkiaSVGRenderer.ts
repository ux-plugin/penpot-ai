/**
 * SkiaSVGRenderer
 *
 * Renders SVG as true vector graphics using CanvasKit.
 * Unlike bitmap-based approaches, this maintains crisp rendering at any zoom level.
 */

import type { CanvasKit, Canvas } from "canvaskit-wasm";
import type { AbsoluteNode } from "@/plugin-ui/utils/pixiNodeRenderer";

/**
 * SVG cache to avoid re-parsing the same SVG multiple times
 */
const svgCache = new Map<string, any>();

/**
 * Parse SVG string and cache the result
 * Note: CanvasKit's SVG support requires the full CanvasKit build with Skia's SVG module
 */
export function parseSVG(
  canvasKit: CanvasKit,
  svgString: string,
  cacheKey?: string,
): any {
  const key = cacheKey || svgString.substring(0, 100);

  if (svgCache.has(key)) {
    return svgCache.get(key);
  }

  // Try to use CanvasKit's SVG DOM support if available
  // Note: This requires CanvasKit to be built with SVG support
  if ("MakeSVGDOM" in canvasKit) {
    try {
      const svgDom = (canvasKit as any).MakeSVGDOM(svgString);
      if (svgDom) {
        svgCache.set(key, svgDom);
        return svgDom;
      }
    } catch (error) {
      console.warn("[SkiaSVGRenderer] MakeSVGDOM failed:", error);
    }
  }

  // Fallback: Parse SVG path data manually for simple SVGs
  const pathData = extractPathFromSVG(svgString);
  if (pathData) {
    try {
      const path = canvasKit.Path.MakeFromSVGString(pathData);
      if (path) {
        svgCache.set(key, { type: "path", path });
        return { type: "path", path };
      }
    } catch (error) {
      console.warn("[SkiaSVGRenderer] Path parsing failed:", error);
    }
  }

  return null;
}

/**
 * Extract path data from simple SVG strings
 */
function extractPathFromSVG(svgString: string): string | null {
  // Try to find a path element's d attribute
  const pathMatch = svgString.match(/<path[^>]*d=["']([^"']+)["'][^>]*>/);
  if (pathMatch && pathMatch[1]) {
    return pathMatch[1];
  }

  // Try to find rect and convert to path
  const rectMatch = svgString.match(
    /<rect[^>]*x=["']?([^"'\s]+)["']?[^>]*y=["']?([^"'\s]+)["']?[^>]*width=["']?([^"'\s]+)["']?[^>]*height=["']?([^"'\s]+)["']?/,
  );
  if (rectMatch) {
    const [, x, y, w, h] = rectMatch.map(parseFloat);
    return `M${x},${y} h${w} v${h} h${-w} Z`;
  }

  // Try to find circle and convert to path
  const circleMatch = svgString.match(
    /<circle[^>]*cx=["']?([^"'\s]+)["']?[^>]*cy=["']?([^"'\s]+)["']?[^>]*r=["']?([^"'\s]+)["']?/,
  );
  if (circleMatch) {
    const [, cx, cy, r] = circleMatch.map(parseFloat);
    // Approximate circle with bezier curves
    const k = 0.5522847498; // Magic number for circular bezier approximation
    return `M${cx - r},${cy} 
            C${cx - r},${cy - k * r} ${cx - k * r},${cy - r} ${cx},${cy - r}
            C${cx + k * r},${cy - r} ${cx + r},${cy - k * r} ${cx + r},${cy}
            C${cx + r},${cy + k * r} ${cx + k * r},${cy + r} ${cx},${cy + r}
            C${cx - k * r},${cy + r} ${cx - r},${cy + k * r} ${cx - r},${cy}
            Z`;
  }

  return null;
}

/**
 * Extract fill color from SVG string
 */
function extractFillColor(
  canvasKit: CanvasKit,
  svgString: string,
): Float32Array | null {
  const fillMatch = svgString.match(/fill=["']([^"']+)["']/);
  if (!fillMatch) return null;

  const fillValue = fillMatch[1];

  // Handle hex colors
  if (fillValue.startsWith("#")) {
    return hexToSkiaColor(canvasKit, fillValue);
  }

  // Handle rgb/rgba
  const rgbMatch = fillValue.match(/rgba?\(([^)]+)\)/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length >= 3) {
      const [r, g, b, a = 255] = parts;
      return canvasKit.Color4f(r / 255, g / 255, b / 255, a > 1 ? a / 255 : a);
    }
  }

  // Handle named colors (basic subset)
  const namedColors: Record<string, string> = {
    black: "#000000",
    white: "#FFFFFF",
    red: "#FF0000",
    green: "#00FF00",
    blue: "#0000FF",
    none: "transparent",
  };

  if (namedColors[fillValue.toLowerCase()]) {
    if (fillValue.toLowerCase() === "none") return null;
    return hexToSkiaColor(canvasKit, namedColors[fillValue.toLowerCase()]);
  }

  return null;
}

/**
 * Convert hex color to CanvasKit color
 */
function hexToSkiaColor(canvasKit: CanvasKit, hex: string): Float32Array {
  // Remove # prefix
  hex = hex.replace("#", "");

  // Handle shorthand hex
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }

  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1;

  return canvasKit.Color4f(r, g, b, a);
}

/**
 * Extract stroke properties from SVG string
 */
function extractStrokeProps(
  canvasKit: CanvasKit,
  svgString: string,
): { color: Float32Array; width: number } | null {
  const strokeMatch = svgString.match(/stroke=["']([^"']+)["']/);
  if (!strokeMatch || strokeMatch[1] === "none") return null;

  const color = hexToSkiaColor(canvasKit, strokeMatch[1]);

  const widthMatch = svgString.match(/stroke-width=["']?([^"'\s]+)["']?/);
  const width = widthMatch ? parseFloat(widthMatch[1]) : 1;

  return { color, width };
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
  const parsed = parseSVG(canvasKit, svgString);

  if (!parsed) {
    // Fallback: draw a placeholder rectangle
    const paint = new canvasKit.Paint();
    paint.setStyle(canvasKit.PaintStyle.Fill);
    paint.setColor(canvasKit.Color4f(0.9, 0.9, 0.9, opacity * 0.5));
    canvas.drawRect(canvasKit.XYWHRect(x, y, width, height), paint);
    paint.delete();
    return false;
  }

  // Handle SVG DOM (if CanvasKit supports it)
  if (parsed.render && typeof parsed.render === "function") {
    canvas.save();
    canvas.translate(x, y);

    // Scale to fit the target dimensions
    const svgWidth = parsed.width?.() || width;
    const svgHeight = parsed.height?.() || height;
    const scaleX = width / svgWidth;
    const scaleY = height / svgHeight;
    canvas.scale(scaleX, scaleY);

    parsed.render(canvas);
    canvas.restore();
    return true;
  }

  // Handle parsed path
  if (parsed.type === "path" && parsed.path) {
    canvas.save();
    canvas.translate(x, y);

    // Get path bounds for scaling
    const bounds = parsed.path.getBounds();
    const pathWidth = bounds[2] - bounds[0];
    const pathHeight = bounds[3] - bounds[1];

    if (pathWidth > 0 && pathHeight > 0) {
      const scaleX = width / pathWidth;
      const scaleY = height / pathHeight;
      canvas.scale(scaleX, scaleY);
      canvas.translate(-bounds[0], -bounds[1]);
    }

    // Draw fill
    const fillColor = extractFillColor(canvasKit, svgString);
    if (fillColor) {
      const fillPaint = new canvasKit.Paint();
      fillPaint.setStyle(canvasKit.PaintStyle.Fill);
      fillPaint.setColor(fillColor);
      fillPaint.setAlphaf(opacity);
      fillPaint.setAntiAlias(true);
      canvas.drawPath(parsed.path, fillPaint);
      fillPaint.delete();
    }

    // Draw stroke
    const strokeProps = extractStrokeProps(canvasKit, svgString);
    if (strokeProps) {
      const strokePaint = new canvasKit.Paint();
      strokePaint.setStyle(canvasKit.PaintStyle.Stroke);
      strokePaint.setColor(strokeProps.color);
      strokePaint.setStrokeWidth(strokeProps.width);
      strokePaint.setAlphaf(opacity);
      strokePaint.setAntiAlias(true);
      canvas.drawPath(parsed.path, strokePaint);
      strokePaint.delete();
    }

    canvas.restore();
    return true;
  }

  return false;
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
  // Delete any CanvasKit objects before clearing
  for (const value of svgCache.values()) {
    if (value?.delete) {
      value.delete();
    } else if (value?.path?.delete) {
      value.path.delete();
    }
  }
  svgCache.clear();
}
