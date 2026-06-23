/**
 * Library asset types & factories — colors and typographies.
 *
 * Storage uses the vendored `penpot-exporter` types directly (FillStyle,
 * TypographyStyle), which already carry the `*RefId` / `*RefFile` fields. This
 * module is the convenience layer: factories, accessors, and the conversion
 * helpers used by apply / sync paths.
 *
 * Shape (mirrors Penpot's `common/types/color.cljc` library-color):
 *   { id, name, path, color | gradient, opacity, modifiedAt }.
 * Stored as the canonical Color in `FillStyle.colors[0]`; `FillStyle.fills[0]`
 * carries a precomputed applied form for swatch rendering.
 *
 * Typography (mirrors `common/types/typography.cljc`): font* + size/weight/etc.
 * plus id/name/path, stored as `TypographyStyle.typography`.
 */

import type {
  Color,
  Fill,
  FillStyle,
  Gradient,
  TextFontStyle,
  TextStyle,
  Typography,
  TypographyStyle,
  Uuid,
} from 'penpot-exporter/types'

export type LibraryColor = FillStyle
export type LibraryTypography = TypographyStyle

// ── Colors ──────────────────────────────────────────────────────────────────

export interface CreateLibraryColorInput {
  id: Uuid
  name: string
  path?: string
  color?: string
  gradient?: Gradient
  opacity?: number
  modifiedAt?: string
}

export function createLibraryColor(input: CreateLibraryColorInput): LibraryColor {
  const canonical: Color = {
    id: input.id,
    name: input.name,
    path: input.path,
    color: input.color,
    gradient: input.gradient,
    opacity: input.opacity ?? 1,
    modifiedAt: input.modifiedAt ?? new Date().toISOString(),
  }
  return {
    name: input.name,
    colors: [canonical],
    fills: [colorToFill(canonical)],
  }
}

/** Source-of-truth Color record on a library color. */
export function libraryColorCanonical(style: LibraryColor): Color | undefined {
  return style.colors?.[0]
}

/**
 * Fill produced from a library color, carrying ref fields back to the style.
 * Used when applying a color style to a shape's fill or stroke (callers map to
 * the stroke-shaped fields separately).
 */
export function libraryColorToFill(style: LibraryColor, fileId: Uuid | undefined): Fill {
  const c = libraryColorCanonical(style)
  return {
    fillColor: c?.color,
    fillColorGradient: c?.gradient,
    fillOpacity: c?.opacity ?? 1,
    fillColorRefId: c?.id,
    fillColorRefFile: fileId,
  }
}

/** Build a LibraryColor from an existing Fill ("create style from selection"). */
export function libraryColorFromFill(
  fill: Fill,
  meta: { id: Uuid; name: string; path?: string },
): LibraryColor {
  return createLibraryColor({
    id: meta.id,
    name: meta.name,
    path: meta.path,
    color: fill.fillColor,
    gradient: fill.fillColorGradient,
    opacity: fill.fillOpacity,
  })
}

function colorToFill(c: Color): Fill {
  return {
    fillColor: c.color,
    fillColorGradient: c.gradient,
    fillOpacity: c.opacity ?? 1,
    fillColorRefId: c.id,
  }
}

// ── Typographies ───────────────────────────────────────────────────────────

export interface CreateLibraryTypographyInput {
  id: Uuid
  name: string
  path?: string
  fontId?: string
  fontFamily?: string
  fontVariantId?: string
  fontSize?: string
  fontWeight?: string
  fontStyle?: TextFontStyle
  lineHeight?: string
  letterSpacing?: string
  textTransform?: string
}

export function createLibraryTypography(
  input: CreateLibraryTypographyInput,
): LibraryTypography {
  const typography: Typography = {
    id: input.id,
    name: input.name,
    path: input.path,
    fontId: input.fontId,
    fontFamily: input.fontFamily,
    fontVariantId: input.fontVariantId,
    fontSize: input.fontSize,
    fontWeight: input.fontWeight,
    fontStyle: input.fontStyle,
    lineHeight: input.lineHeight,
    letterSpacing: input.letterSpacing,
    textTransform: input.textTransform,
  }
  return {
    name: input.name,
    textStyle: typographyToTextStyle(typography),
    typography,
  }
}

export function libraryTypographyCanonical(style: LibraryTypography): Typography {
  return style.typography
}

/**
 * TextStyle patch to merge onto spans/paragraphs when applying a typography.
 * Includes cached values + ref fields, matching Penpot's apply-typography flow.
 */
export function libraryTypographyToTextStyle(
  style: LibraryTypography,
  fileId: Uuid | undefined,
): TextStyle {
  const t = style.typography
  return {
    fontId: t.fontId,
    fontFamily: t.fontFamily,
    fontVariantId: t.fontVariantId,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    textTransform: t.textTransform,
    typographyRefId: t.id,
    typographyRefFile: fileId,
  }
}

/** Build a LibraryTypography from an existing TextStyle ("create from selection"). */
export function libraryTypographyFromTextStyle(
  ts: TextStyle,
  meta: { id: Uuid; name: string; path?: string },
): LibraryTypography {
  return createLibraryTypography({
    id: meta.id,
    name: meta.name,
    path: meta.path,
    fontId: ts.fontId,
    fontFamily: ts.fontFamily,
    fontVariantId: ts.fontVariantId,
    fontSize: ts.fontSize,
    fontWeight: ts.fontWeight,
    fontStyle: ts.fontStyle,
    lineHeight: ts.lineHeight,
    letterSpacing: ts.letterSpacing,
    textTransform: ts.textTransform,
  })
}

function typographyToTextStyle(t: Typography): TextStyle {
  return {
    fontId: t.fontId,
    fontFamily: t.fontFamily,
    fontVariantId: t.fontVariantId,
    fontSize: t.fontSize,
    fontWeight: t.fontWeight,
    fontStyle: t.fontStyle,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    textTransform: t.textTransform,
    typographyRefId: t.id,
  }
}
