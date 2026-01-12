/**
 * Utility functions for parsing and converting SVG strings
 */

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
 * Converts SVG data to a string for rendering
 */
export function convertSVGToString(svg?: string): string | null {
  if (!svg) return null;

  return parseSVGString(svg);
}

/**
 * Converts SVG data to SVGElement
 */
export function parseSVGToElement(svg?: string): SVGElement | null {
  const svgString = convertSVGToString(svg);
  if (!svgString) return null;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svgElement = doc.querySelector('svg');

  return svgElement || null;
}
