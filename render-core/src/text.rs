//! Backend-neutral text content — the *input* a backend shapes, never resolved glyphs.
//!
//! Unlike a rect or a path, a text shape cannot be reduced to geometry at the handoff: render-wasm
//! lays it out with Skia's `textlayout` and render-vello with Parley, and the two shapers do not
//! agree glyph-for-glyph (different line breaking, kerning, hinting). So the neutral model carries
//! what the host *sent* — paragraphs of styled spans and the box they flow in — and each backend
//! shapes it itself. The differential digest hashes this input, which both projections agree on;
//! the drawn glyph positions differing is a rasteriser difference, out of the digest's scope, the
//! same stance it takes on antialiasing.
//!
//! This is the first text increment, so it deliberately omits what render-wasm also carries and a
//! later slice will add: text strokes, decorations (underline/line-through/overline), text
//! transforms, explicit direction/RTL, per-span multi-fill, and emoji/COLR handling. Each is
//! dropped at projection on *both* sides so the digest still agrees while the feature is absent.

use peniko::Color;

/// A reference to an uploaded font face. Penpot identifies a face by a family UUID plus a weight
/// and a style, exactly as render-wasm's `FontFamily { id, weight, style }` does; the two backends
/// resolve that reference against their own font store (a Skia `TypefaceFontProvider` alias on one
/// side, a Parley collection on the other).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FontRef {
    /// Family UUID packed as a u128 — the same id the host uploads under (`store_font`).
    pub id: u128,
    /// CSS weight, `100..=900`.
    pub weight: u16,
    /// `true` for italic/oblique, matching render-wasm's `RawFontStyle::Italic == 1`.
    pub italic: bool,
}

/// Horizontal alignment of a paragraph. Wire values are render-wasm's `RawTextAlign`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
    Right,
    Justify,
}

impl TextAlign {
    /// Decode the wire byte; anything unknown is `Left`, the CSS/Penpot default.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::Center,
            2 => Self::Right,
            3 => Self::Justify,
            _ => Self::Left,
        }
    }
}

/// Vertical alignment of the whole block within its box. Wire values are render-wasm's
/// `VerticalAlign` (`Top 0, Center 1, Bottom 2`); unlike the horizontal align it lives on the
/// shape, not the paragraph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerticalAlign {
    Top,
    Center,
    Bottom,
}

impl VerticalAlign {
    /// Decode the wire byte; anything unknown is `Top`.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::Center,
            2 => Self::Bottom,
            _ => Self::Top,
        }
    }
}

/// How the box sizes to its content. Wire values are render-wasm's `GrowType`.
///
/// - `Fixed` — the box is the shape's `bounds`; text wraps to that width and is clipped past it.
/// - `AutoWidth` — no wrapping; the box grows to the longest line.
/// - `AutoHeight` — wraps to the box width; the box grows to the total text height.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextGrow {
    Fixed,
    AutoWidth,
    AutoHeight,
}

impl TextGrow {
    /// Decode the wire byte; anything unknown is `Fixed`.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::AutoWidth,
            2 => Self::AutoHeight,
            _ => Self::Fixed,
        }
    }
}

/// A run of characters sharing one style. Mirrors render-wasm's `TextSpan`, trimmed to the fields
/// this slice draws.
#[derive(Clone, Debug, PartialEq)]
pub struct TextSpan {
    pub text: String,
    pub font: FontRef,
    pub size: f32,
    /// Line height as a multiple of the font size (render-wasm normalises to this).
    pub line_height: f32,
    /// Extra tracking between characters, in the text's own units.
    pub letter_spacing: f32,
    /// The single fill this slice paints. render-wasm allows up to eight fills per span; here the
    /// first paintable one wins and the rest are dropped until a later slice.
    pub color: Color,
}

/// One paragraph: its own alignment and default metrics, and the spans that make it up.
#[derive(Clone, Debug, PartialEq)]
pub struct TextParagraph {
    pub align: TextAlign,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub spans: Vec<TextSpan>,
}

/// A text shape's whole content: the paragraphs, how the box grows, and where the block sits in it.
///
/// Held on [`crate::model::Node::text`] when the node's kind is [`crate::model::ShapeKind::Text`].
/// The box itself is the node's `bounds`, so it is not repeated here.
#[derive(Clone, Debug, PartialEq)]
pub struct TextBlock {
    pub paragraphs: Vec<TextParagraph>,
    pub grow: TextGrow,
    pub vertical_align: VerticalAlign,
}

impl TextBlock {
    /// Whether this block would put any glyph on the canvas — a paragraph with a non-empty span.
    /// Used by the paintable walk to tell a delivered-but-empty text box from a drawn one.
    pub fn is_empty(&self) -> bool {
        self.paragraphs
            .iter()
            .all(|p| p.spans.iter().all(|s| s.text.is_empty()))
    }
}
