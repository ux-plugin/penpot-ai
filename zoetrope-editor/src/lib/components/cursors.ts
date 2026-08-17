// Custom canvas cursors built from the toolbar glyphs so the cursor matches the
// active tool. Each is drawn with a white halo / outline so it stays visible on
// any artboard, and encoded as an SVG data-URI CSS cursor with a hotspot.

// --- Select / move tool: lucide `MousePointer2` (the toolbar select glyph). ---
const SELECT_ARROW_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
  "<path d='M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z' " +
  "fill='#1e1e1e' stroke='#ffffff' stroke-width='1.5' stroke-linejoin='round'/></svg>"

// Hotspot (4,4) sits on the arrow tip. Falls back to the OS arrow.
export const SELECT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(SELECT_ARROW_SVG)}") 4 4, default`

// --- Pen tool / vector add-anchor band: lucide `PenTool`. ---
// Without it the add-anchor band falls back to the OS `copy` cursor (a green
// plus), which duplicates the "add" hint chip.
const PEN_PATHS =
  "<path d='M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z'/>" +
  "<path d='m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18'/>" +
  "<path d='m2.3 2.3 7.286 7.286'/>" +
  "<circle cx='11' cy='11' r='2'/>"

const PEN_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke-linecap='round' stroke-linejoin='round'>" +
  `<g stroke='#ffffff' stroke-width='3'>${PEN_PATHS}</g>` +
  `<g stroke='#1e1e1e' stroke-width='1.5'>${PEN_PATHS}</g>` +
  '</svg>'

// Hotspot (2,2) sits on the nib tip. Falls back to a crosshair if the browser
// can't load the SVG cursor (notably NOT `copy`, to avoid the green plus).
export const PEN_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PEN_SVG)}") 2 2, crosshair`

// Move AND Bend both use SELECT_CURSOR (the `MousePointer2` arrow). Move's menu
// icon IS that arrow; Bend keeps the same pointer and is distinguished instead by
// its trailing hint chip (the spline icon, shown only over a node) — see
// PathEditorOverlay's PATH_INTENT_ICONS.
