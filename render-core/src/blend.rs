//! Blend modes, backend-neutral.
//!
//! Penpot sends a blend mode as a single `RawBlendMode` byte over the wire
//! (`set_shape_blend_mode`); render-wasm turns it into a `skia::BlendMode`, render-vello into a
//! `peniko::BlendMode`. For the differential harness to agree, both must land on the *same*
//! neutral value for the same byte — so the byte→peniko mapping lives here, once, and both sides
//! route through it (render-vello directly; render-wasm's `skia → peniko` adapter is pinned
//! equal to it by a test).
//!
//! Penpot's sixteen modes are all *separable/non-separable mixes* composited source-over — i.e.
//! a `peniko::Mix` with `Compose::SrcOver`. None of them changes the compositing operator.

use peniko::{BlendMode, Compose, Mix};

/// The mode a shape has when the host never sets one: Penpot's `SrcOver`, i.e. plain normal
/// blending. Both backends default to this, so a node carrying it composites identically without
/// any layer at all.
pub const DEFAULT_BLEND: BlendMode = BlendMode::new(Mix::Normal, Compose::SrcOver);

/// Map a `RawBlendMode` byte to its neutral blend mode.
///
/// The byte values are Penpot's and are not contiguous (`Normal = 3`, `Screen = 14 …
/// Luminosity = 28`); they match `render-wasm`'s `RawBlendMode`. Anything unrecognised falls back
/// to normal — the same thing render-wasm's default does — rather than guessing.
pub fn blend_from_raw(raw: u8) -> BlendMode {
    let mix = match raw {
        3 => Mix::Normal,
        14 => Mix::Screen,
        15 => Mix::Overlay,
        16 => Mix::Darken,
        17 => Mix::Lighten,
        18 => Mix::ColorDodge,
        19 => Mix::ColorBurn,
        20 => Mix::HardLight,
        21 => Mix::SoftLight,
        22 => Mix::Difference,
        23 => Mix::Exclusion,
        24 => Mix::Multiply,
        25 => Mix::Hue,
        26 => Mix::Saturation,
        27 => Mix::Color,
        28 => Mix::Luminosity,
        _ => Mix::Normal,
    };
    BlendMode::new(mix, Compose::SrcOver)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_normal_source_over() {
        assert_eq!(DEFAULT_BLEND, BlendMode::new(Mix::Normal, Compose::SrcOver));
        assert_eq!(blend_from_raw(3), DEFAULT_BLEND);
    }

    #[test]
    fn every_raw_mode_maps_and_composites_source_over() {
        // The sixteen bytes Penpot can send, in RawBlendMode order.
        let expected = [
            (3u8, Mix::Normal),
            (14, Mix::Screen),
            (15, Mix::Overlay),
            (16, Mix::Darken),
            (17, Mix::Lighten),
            (18, Mix::ColorDodge),
            (19, Mix::ColorBurn),
            (20, Mix::HardLight),
            (21, Mix::SoftLight),
            (22, Mix::Difference),
            (23, Mix::Exclusion),
            (24, Mix::Multiply),
            (25, Mix::Hue),
            (26, Mix::Saturation),
            (27, Mix::Color),
            (28, Mix::Luminosity),
        ];
        for (raw, mix) in expected {
            let b = blend_from_raw(raw);
            assert_eq!(b.mix, mix, "raw {raw}");
            assert_eq!(b.compose, Compose::SrcOver, "raw {raw}");
        }
    }

    #[test]
    fn an_unknown_byte_falls_back_to_normal() {
        assert_eq!(blend_from_raw(0), DEFAULT_BLEND);
        assert_eq!(blend_from_raw(99), DEFAULT_BLEND);
    }
}
