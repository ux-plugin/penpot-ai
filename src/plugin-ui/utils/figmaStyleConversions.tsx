/**
 * Utility functions for converting Figma styles to CSS
 * These functions help transform Figma design properties into browser-compatible CSS styles
 */

import type { StyledTextSegment, FrameNodeData } from "@components/nodes/node.types.ts";
import React from "react";

/**
 * Converts a Figma Paint object to a CSS color string
 */
export const convertPaintToCSS = (paint: Paint): string => {
  if (paint.type === 'SOLID' && paint.color) {
    const { r, g, b } = paint.color;
    const opacity = paint.opacity ?? 1;
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${opacity})`;
  }

  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_ANGULAR' || paint.type === 'GRADIENT_DIAMOND') {
    // For gradients, return the first color as a fallback
    const firstStop = paint.gradientStops?.[0];
    if (firstStop?.color) {
      const { r, g, b } = firstStop.color;
      return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
    }
  }

  // Default fallback
  return 'transparent';
};

/**
 * Converts Figma BlendMode to CSS mix-blend-mode
 */
export const convertBlendModeToCSS = (blendMode?: BlendMode): string | undefined => {
  if (!blendMode || blendMode === 'PASS_THROUGH' || blendMode === 'NORMAL') {
    return undefined;
  }

  const blendModeMap: Record<string, string> = {
    'DARKEN': 'darken',
    'MULTIPLY': 'multiply',
    'COLOR_BURN': 'color-burn',
    'LIGHTEN': 'lighten',
    'SCREEN': 'screen',
    'COLOR_DODGE': 'color-dodge',
    'OVERLAY': 'overlay',
    'SOFT_LIGHT': 'soft-light',
    'HARD_LIGHT': 'hard-light',
    'DIFFERENCE': 'difference',
    'EXCLUSION': 'exclusion',
    'HUE': 'hue',
    'SATURATION': 'saturation',
    'COLOR': 'color',
    'LUMINOSITY': 'luminosity',
  };

  return blendModeMap[blendMode];
};

/**
 * Converts Figma effects to CSS box-shadow and filter
 */
export const convertEffectsToCSS = (effects?: readonly Effect[]): { boxShadow?: string; filter?: string } => {
  if (!effects || effects.length === 0) {
    return {};
  }

  const shadows: string[] = [];
  const filters: string[] = [];

  effects.forEach(effect => {
    if (!effect.visible) return;

    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      const { offset, radius, color } = effect;
      const x = offset?.x ?? 0;
      const y = offset?.y ?? 0;
      const blur = radius ?? 0;
      const colorStr = color
        ? `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${color.a ?? 1})`
        : 'rgba(0, 0, 0, 0.25)';

      const inset = effect.type === 'INNER_SHADOW' ? 'inset ' : '';
      shadows.push(`${inset}${x}px ${y}px ${blur}px ${colorStr}`);
    }

    if (effect.type === 'LAYER_BLUR') {
      const blur = effect.radius ?? 0;
      filters.push(`blur(${blur}px)`);
    }

    if (effect.type === 'BACKGROUND_BLUR') {
      const blur = effect.radius ?? 0;
      filters.push(`blur(${blur}px)`);
    }
  });

  return {
    boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
    filter: filters.length > 0 ? filters.join(' ') : undefined,
  };
};

/**
 * Converts Figma text alignment to CSS
 */
export const convertTextAlignToCSS = (
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED",
): React.CSSProperties["textAlign"] => {
  const alignMap = {
    LEFT: "left",
    CENTER: "center",
    RIGHT: "right",
    JUSTIFIED: "justify",
  } as const;

  return alignMap[align ?? "LEFT"];
};

/**
 * Converts Figma vertical alignment to CSS
 */
export const convertVerticalAlignToCSS = (align?: 'TOP' | 'CENTER' | 'BOTTOM'): string => {
  const alignMap: Record<string, string> = {
    'TOP': 'flex-start',
    'CENTER': 'center',
    'BOTTOM': 'flex-end',
  };

  return alignMap[align ?? 'TOP'] ?? 'flex-start';
};
/**
 * Renders a styled text segment with its individual properties
 */
export const renderStyledSegment = (
  segment: StyledTextSegment,
  index: number,
  strokeColor?: string,
  strokeWeight?: number,
  boxShadow?: string,
  filter?: string,
  blendMode?: string
) => {
  const style: React.CSSProperties = {
    fontSize: segment.fontSize ? `${segment.fontSize}px` : undefined,
    fontWeight: segment.fontWeight ?? undefined,
    fontFamily: segment.fontName?.family ?? undefined,
    fontStyle: segment.fontName.style ?? undefined,
    textTransform: segment.textCase === 'UPPER' ? 'uppercase'
      : segment.textCase === 'LOWER' ? 'lowercase'
        : segment.textCase === 'TITLE' ? 'capitalize'
          : undefined,
    textDecoration: segment.textDecoration === 'UNDERLINE' ? 'underline'
      : segment.textDecoration === 'STRIKETHROUGH' ? 'line-through'
        : undefined,
    letterSpacing: segment.letterSpacing?.unit === 'PIXELS'
      ? `${segment.letterSpacing.value}px`
      : segment.letterSpacing?.unit === 'PERCENT'
        ? `${segment.letterSpacing.value}%`
        : undefined,
    lineHeight: segment.lineHeight?.unit === 'PIXELS'
      ? `${segment.lineHeight.value}px`
      : segment.lineHeight?.unit === 'PERCENT'
        ? `${segment.lineHeight.value}%`
        : undefined,
    color: segment.fills?.[0] ? convertPaintToCSS(segment.fills[0]) : undefined,
    WebkitTextStrokeWidth: strokeWeight ? `${strokeWeight}px` : undefined,
    WebkitTextStrokeColor: strokeColor,
    boxShadow: boxShadow,
    filter: filter,
    mixBlendMode: blendMode as any,
  } as React.CSSProperties;

  const content = segment.characters;

  // Handle hyperlinks
  if (segment.hyperlink?.type === 'URL') {
    return (
      <a
        key={index}
        href={segment.hyperlink.value}
        style={style}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }

  return (
    <span key={index} style={style}>
      {content}
    </span>
  );
};

// @/src/utils/svgParser.ts
export function parseSVGString(svgString: string): string {
  // Unescape quotes and newlines
  return svgString
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '')
    .trim();
}

// Alternative: Parse to React component props
export function parseSVGToProps(svgString?: string) {
  if (!svgString) return null;
  const cleanSVG = parseSVGString(svgString);
  const parser = new DOMParser();
  const doc = parser.parseFromString(cleanSVG, 'image/svg+xml');
  const svgElement = doc.querySelector('svg');

  if (!svgElement) return null;

  return svgElement
}

/**
 * Converts SVG data (string or Uint8Array) to a string for rendering
 */
export function convertSVGToString(svg?: string | Uint8Array): string | null {
  if (!svg) return null;

  if (typeof svg === 'string') {
    return parseSVGString(svg);
  }

  // Convert Uint8Array to string
  const decoder = new TextDecoder('utf-8');
  return decoder.decode(svg);
}

/**
 * Converts SVG data (string or Uint8Array) to SVGElement
 */
export function parseSVGToElement(svg?: string | Uint8Array): SVGElement | null {
  const svgString = convertSVGToString(svg);
  if (!svgString) return null;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svgElement = doc.querySelector('svg');

  return svgElement || null;
}

/**
 * Converts a Figma Frame Node's data to CSS styles for rendering
 * Only handles simple cases (solid fills, basic strokes, simple effects)
 * Complex cases (gradients, blurs, etc.) should use SVG export
 * 
 * @param nodeData - The frame node data to convert
 * @returns CSS properties object for React styling
 */
export function convertFrameNodeToCSS(nodeData: FrameNodeData): React.CSSProperties {
  const style: React.CSSProperties = {
    width: nodeData.width,
    height: nodeData.height,
    opacity: nodeData.opacity,
    transform: nodeData.rotation ? `rotate(${nodeData.rotation}deg)` : undefined,
    mixBlendMode: convertBlendModeToCSS(nodeData.blendMode) as any,
  };

  // Handle fills (only solid colors)
  if (nodeData.fills && nodeData.fills.length > 0) {
    const firstFill = nodeData.fills[0];
    // Only use CSS for solid fills
    if (firstFill.type === 'SOLID') {
      style.backgroundColor = convertPaintToCSS(firstFill);
    } else {
      // For non-solid fills, we can't render with CSS
      // This should have been caught by shouldUseSVG()
      style.backgroundColor = 'transparent';
    }
  } else {
    style.backgroundColor = 'transparent';
  }

  // Handle strokes (simple strokes only)
  if (nodeData.strokes && nodeData.strokes.length > 0 && nodeData.strokeWeight) {
    const strokePaint = nodeData.strokes[0];
    const strokeColor = convertPaintToCSS(strokePaint);

    // Handle uniform stroke weight
    const { top, right, bottom, left } = nodeData.strokeWeight;
    const isUniform = top === right && right === bottom && bottom === left;

    if (isUniform && top > 0) {
      // Use border for uniform strokes
      const strokeAlign = nodeData.strokeAlign || 'INSIDE';

      if (strokeAlign === 'CENTER') {
        style.border = `${top}px solid ${strokeColor}`;
      } else if (strokeAlign === 'INSIDE') {
        // For INSIDE strokes, Figma draws the stroke inside the bounds without changing visual size
        // Use inset box-shadow to draw inside without affecting layout dimensions
        // This matches Figma's behavior where INSIDE stroke doesn't change the visual size
        style.boxShadow = `inset 0 0 0 ${top}px ${strokeColor}`;
      } else {
        // OUTSIDE - use box-shadow with spread to draw outside the bounds
        // This better matches Figma's OUTSIDE stroke rendering than outline
        style.boxShadow = `0 0 0 ${top}px ${strokeColor}`;
      }
    } else if (!isUniform) {
      // Non-uniform strokes are complex, but we can approximate with border
      // This is a fallback - ideally should use SVG
      style.borderTop = `${top}px solid ${strokeColor}`;
      style.borderRight = `${right}px solid ${strokeColor}`;
      style.borderBottom = `${bottom}px solid ${strokeColor}`;
      style.borderLeft = `${left}px solid ${strokeColor}`;
    }
  }

  // Handle corner radius
  if (nodeData.cornerRadius) {
    const { topLeft, topRight, bottomRight, bottomLeft } = nodeData.cornerRadius;
    const isUniform = topLeft === topRight && topRight === bottomRight && bottomRight === bottomLeft;

    if (isUniform) {
      style.borderRadius = `${topLeft}px`;
    } else {
      style.borderRadius = `${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px`;
    }
  }

  // Handle effects (simple shadows only)
  const effects = convertEffectsToCSS(nodeData.effects);
  if (effects.boxShadow) {
    // Combine stroke boxShadow (if exists) with effect boxShadow
    // Stroke boxShadow uses inset for INSIDE strokes, effects use regular shadows
    if (style.boxShadow) {
      // Combine both shadows: stroke (inset) first, then effect shadows
      style.boxShadow = `${style.boxShadow}, ${effects.boxShadow}`;
    } else {
      style.boxShadow = effects.boxShadow;
    }
  }
  if (effects.filter) {
    // Note: CSS filters may not perfectly match Figma effects
    // For complex filters, SVG is preferred
    style.filter = effects.filter;
  }

  return style;
}