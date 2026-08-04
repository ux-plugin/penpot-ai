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
//! Text increments so far carry per-span **decoration** (underline/line-through/overline), the
//! full per-span **fill list** (so a gradient or layered text fill crosses, not just the first
//! solid colour), per-span **case transform** and the paragraph's base **direction** (RTL). Text
//! strokes ride on the node's shape-level `strokes`, not here. Still deliberately omitted, to be
//! added by a later slice and dropped at projection on *both* sides so the digest stays in
//! agreement while absent: emoji/COLR fallback, text effects, and the editor.

use crate::model::Paint;

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

/// A line drawn along a span's text. Wire values are render-wasm's `RawTextDecoration`; Skia's own
/// `TextDecoration` is a bitflag set, but the wire only ever carries one, so this is a plain enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TextDecoration {
    #[default]
    None,
    Underline,
    LineThrough,
    Overline,
}

impl TextDecoration {
    /// Decode the wire byte; anything unknown is `None`.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::Underline,
            2 => Self::LineThrough,
            3 => Self::Overline,
            _ => Self::None,
        }
    }
}

/// Case folding applied to a span's text before shaping. Wire values are render-wasm's
/// `RawTextTransform`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TextTransform {
    #[default]
    None,
    Uppercase,
    Lowercase,
    Capitalize,
}

impl TextTransform {
    /// Decode the wire byte; anything unknown is `None`.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::Uppercase,
            2 => Self::Lowercase,
            3 => Self::Capitalize,
            _ => Self::None,
        }
    }

    /// Apply this transform to a string, matching render-wasm's `apply_text_transform` /
    /// `capitalize_words` so both backends fold identically (the neutral model carries the *raw*
    /// text and this enum; each backend folds at shaping time). `Capitalize` upper-cases the first
    /// alphabetic char after every non-alphabetic one.
    pub fn apply(self, text: &str) -> String {
        match self {
            Self::None => text.to_string(),
            Self::Uppercase => text.to_uppercase(),
            Self::Lowercase => text.to_lowercase(),
            Self::Capitalize => {
                let mut result = String::with_capacity(text.len());
                let mut capitalize_next = true;
                for c in text.chars() {
                    if c.is_alphabetic() {
                        if capitalize_next {
                            result.extend(c.to_uppercase());
                        } else {
                            result.push(c);
                        }
                        capitalize_next = false;
                    } else {
                        result.push(c);
                        capitalize_next = true;
                    }
                }
                result
            }
        }
    }
}

/// The base writing direction of a paragraph. Wire values are render-wasm's `RawTextDirection`
/// (`Ltr 0, Rtl 1`). Parley resolves the Unicode bidi algorithm from the text content on its own;
/// this only forces the *base* level, which matters for neutral or mixed runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TextDirection {
    #[default]
    Ltr,
    Rtl,
}

impl TextDirection {
    /// Decode the wire byte; anything unknown is `Ltr`.
    pub fn from_wire(value: u8) -> Self {
        match value {
            1 => Self::Rtl,
            _ => Self::Ltr,
        }
    }
}

/// A run of characters sharing one style. Mirrors render-wasm's `TextSpan`, trimmed to the fields
/// the backends draw.
#[derive(Clone, Debug, PartialEq)]
pub struct TextSpan {
    pub text: String,
    pub font: FontRef,
    pub size: f32,
    /// Line height as a multiple of the font size (render-wasm normalises to this).
    pub line_height: f32,
    /// Extra tracking between characters, in the text's own units.
    pub letter_spacing: f32,
    /// The span's fills, bottom-to-top — the same up-to-eight fills render-wasm layers over the
    /// glyphs. A backend draws the glyph coverage once per paintable fill; the first fill's colour
    /// also tints the decoration line. Empty means nothing paints (no fallback colour is invented).
    pub fills: Vec<Paint>,
    /// The line drawn along the text, if any.
    pub decoration: TextDecoration,
    /// Case folding applied to `text` before shaping. `text` stays raw; the fold happens at draw.
    pub transform: TextTransform,
}

/// One paragraph: its own alignment and default metrics, and the spans that make it up.
#[derive(Clone, Debug, PartialEq)]
pub struct TextParagraph {
    pub align: TextAlign,
    /// Base writing direction; forces the bidi base level (Parley resolves the rest from content).
    pub direction: TextDirection,
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
