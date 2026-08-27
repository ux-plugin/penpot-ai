//! `bake` — the ONE place an effect becomes the fine descriptors that run it.
//!
//! Today the whole-viewport emitter (`render_whole_viewport`) reconstructs, per effect kind, both the
//! descriptor bytes AND the scaffolding around them: `stack_markers`/`fx_markers`/`fx_offset` maps, the
//! `ShadowRole`-driven `eid` choice, and the intra-effect round layout (`schedule_shadows`, the frost
//! five-round block). That scaffolding exists only to reconcile four per-effect planners against one
//! marker stream. `bake` dissolves it: `Sink::bake_effect` returns the effect's ordered [`Baked`]
//! list — each descriptor already carrying its `eid` and its `round_off` — so the emitter is a flat
//! loop over `frame_dag`'s markers.
//!
//! The descriptor is the seam `fine.wgsl` reads: `[bits, program, 6×vec4 u]` = 26 floats, packed into
//! `effect_params` at the offset the marker carries. `bits` selects the head + pointwise tail + the
//! composite mode; `program` selects the field ([`PROGRAM_LENS`] / [`PROGRAM_RADIAL`]); `u` is the
//! `units_uniform` the field and its units read. This module owns that vocabulary so both the current
//! `fine.wgsl` and the clean `new_fine.wgsl` read one definition of it.

use crate::vello::units::UnitOp;

/// The `bits` field (descriptor slot 0) — one flag per unit/mode the fine CMD_EFFECT arm branches on.
/// Mirrors the literals `fine.wgsl` tests (`fx_applyPointwise` + the CMD_EFFECT interpreter); named
/// here so a descriptor is assembled from `bits::WARP | bits::SHADE`, never a bare `56.0`.
pub mod bits {
    /// Pointwise multiply by the input's own alpha at the undisplaced pixel — confines a displaced
    /// result to the coverage it started from (`ClipToSource`).
    pub const CLIP: u32 = 1;
    /// Pointwise erase by a second input's alpha (`DestOut`) — the inner-shadow punch.
    pub const ERASE: u32 = 2;
    /// Pointwise multiply by a straight colour, premultiplied out — a coverage silhouette → coloured.
    pub const TINT: u32 = 4;
    /// Pointwise specular/shade term, weighted by the field's specular output.
    pub const SHADE: u32 = 8;
    /// Pointwise final lerp against the second input by the field's mask output.
    pub const MASKMIX: u32 = 16;
    /// Sampling head: masked displaced read of the materialized backdrop (lens refraction).
    pub const WARP: u32 = 32;
    /// One axis of a separable Gaussian (axis in `u[0].xy`, sigma `u[0].z`).
    pub const BLUR: u32 = 64;
    /// Composite the value as a straight colour source-OVER the accumulator (shadow spread), not the
    /// masked mix a backdrop effect uses.
    pub const SPREAD: u32 = 128;
    /// Sampling head: jittered read of the input (the frost scatter).
    pub const SCATTER: u32 = 256;
    /// Write the result UNMASKED to a scratch (an intermediate link of a chained gather).
    pub const MATERIALIZE: u32 = 512;
    /// Blur/scatter in sRGB rather than linear light (frosted lens; a background blur is linear).
    pub const SRGB: u32 = 1024;
    /// A silhouette blur over transparency (a shadow) — OOB taps are transparent 0, not the page.
    pub const SHADOW_EDGE: u32 = 2048;
    /// Text inner flood: recover unoffset glyph coverage from the offset silhouette.
    pub const FLOOD_ERASE: u32 = 4096;
    /// The band reads a precomputed scratch coverage (`value.a`) rather than `area[i]` + erase.
    pub const SCRATCH_COV: u32 = 8192;
}

/// The field program a descriptor selects (`program`, slot 1). `0` = no field (a plain tint stamp).
pub const PROGRAM_NONE: f32 = 0.0;
/// The rounded-box/sampled lens field (`computeField` for glass).
pub const PROGRAM_LENS: f32 = 1.0;
/// The radial-ramp field (background-field tint: mask fades from the silhouette centre).
pub const PROGRAM_RADIAL: f32 = 3.0;

/// The `effect_id` a marker carries — both are `>= EFFECT_INLINE_BASE`, so `fine` runs the descriptor
/// inline. They differ only in coverage: [`EID_MASKED`] keeps the rasterised silhouette (`area[i]`) so
/// the final composite is clipped to the shape's outline; [`EID_MATERIALIZE`] uses the dilated reach
/// rect so an intermediate link writes its full field to scratch without clipping.
pub const EID_MASKED: u32 = 100;
/// A materialize/dilated marker — an intermediate gather link, or a spread laid over the dilated reach.
pub const EID_MATERIALIZE: u32 = 101;

/// One baked fine arm: the descriptor `fine` reads (`params`), the `eid` that sets its coverage, and
/// the `round_off` — this arm's round RELATIVE to the effect's base round (a separable blur's V is
/// `round_off = 1`, an inner band sits after the pre-body rounds). The emitter adds the effect's base
/// round (from `frame_dag`'s schedule) and a strictly-increasing `z`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Baked {
    pub eid: u32,
    pub round_off: u32,
    pub params: [f32; 26],
}

impl Baked {
    /// Assemble a descriptor from its parts: `bits` and `program` in slots 0/1, the 24-float
    /// (`6×vec4`) unit uniform in slots 2..26.
    #[must_use]
    pub fn new(eid: u32, round_off: u32, bits: u32, program: f32, u: &[f32; 24]) -> Self {
        let mut params = [0.0f32; 26];
        params[0] = bits as f32;
        params[1] = program;
        params[2..26].copy_from_slice(u);
        Baked { eid, round_off, params }
    }

    /// The `bits` this descriptor carries (slot 0), back as an integer for tests/queries.
    #[must_use]
    pub fn bits(&self) -> u32 {
        self.params[0] as u32
    }
}

/// The policy bits an arm carries that come from its POSITION and compose-mode, not its units — the
/// honest residue `bits_of` cannot see from the run alone (see the "four policy bits" analysis).
/// `spread` = a colour-layer composite (a shadow's `Compose::Under`/`Over`, laying `u[3]` over) rather
/// than the field-masked mix a backdrop effect uses; `materialize` = an intermediate link of a chained
/// gather (writes its scratch UNMASKED); `shadow_edge` = a silhouette blur (OOB taps fade to
/// transparent, not the page). All three are derivable at bake time from the effect's compose-mode and
/// the arm's place in the chain — never a stored tag.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub spread: bool,
    pub materialize: bool,
    pub shadow_edge: bool,
}

/// Map a fused unit run to the descriptor's `bits` word — the ONE genuinely-new derivation of the bake
/// rebase, and pure. Each unit sets its own flag: a sampling head (`Warp`/`Scatter`), a `Blur` (with
/// `SRGB` when it mixes in gamma space), and the pointwise tail (`Shade`/`MaskMix`/`Tint`/`Clip`/
/// `Erase`). A `Custom` carries its behaviour in its program, not a bit; structural ops never appear in
/// a run. Whether a trailing `Tint` is a `TINT` pointwise (a backdrop tint) or the colour of a `SPREAD`
/// composite (a shadow) is decided by arm-GROUPING upstream — a spread arm's run is the gather alone,
/// its colour riding `u[3]` — so `bits_of` needs no compose context.
#[must_use]
pub fn bits_of(run: &[UnitOp]) -> u32 {
    run.iter().fold(0u32, |b, u| {
        b | match u {
            UnitOp::Warp(_) => bits::WARP,
            UnitOp::Scatter(_) => bits::SCATTER,
            UnitOp::Blur { linear, .. } => bits::BLUR | if *linear { 0 } else { bits::SRGB },
            UnitOp::Shade(_) => bits::SHADE,
            UnitOp::MaskMix(_) => bits::MASKMIX,
            UnitOp::Tint(_) => bits::TINT,
            UnitOp::ClipToSource(_) => bits::CLIP,
            UnitOp::EraseBy(_) => bits::ERASE,
            UnitOp::Custom { .. } | UnitOp::Rasterize | UnitOp::Reload | UnitOp::Compose => 0,
        }
    })
}

/// The complete `bits` word for one arm: its unit-derived bits plus the position/compose policy bits.
#[must_use]
pub fn arm_bits(run: &[UnitOp], p: Policy) -> u32 {
    bits_of(run)
        | if p.spread { bits::SPREAD } else { 0 }
        | if p.materialize { bits::MATERIALIZE } else { 0 }
        | if p.shadow_edge { bits::SHADOW_EDGE } else { 0 }
}

/// Serialize one fused arm to the 26-float descriptor `fine` reads: `bits` (slot 0) from `arm_bits`,
/// `program` (slot 1) from `program_of` unless the effect overrode it, and the merged unit uniform
/// (slots 2..26) from [`crate::vello::units::units_uniform`]. This is the whole "serialize" step — a
/// pure function over units the scheduler already filled, replacing the four planners' descriptor
/// assembly. `program` is `Some` when the effect fixes the field (radial for a background field), else
/// derived from the run.
#[must_use]
pub fn arm_descriptor(run: &[UnitOp], policy: Policy, program: Option<f32>) -> [f32; 26] {
    let mut d = [0.0f32; 26];
    d[0] = arm_bits(run, policy) as f32;
    d[1] = program.unwrap_or_else(|| program_of(run));
    d[2..26].copy_from_slice(&crate::vello::units::units_uniform(run));
    d
}

/// The field program a run measures: a lens field when any unit reads it (a head or a field-measuring
/// pointwise), else no field (a plain stamp). A radial/sampled/custom field is set by the effect at
/// bake time — this covers the common lens case.
#[must_use]
pub fn program_of(run: &[UnitOp]) -> f32 {
    let reads_field = run.iter().any(|u| {
        matches!(u, UnitOp::Warp(_) | UnitOp::Scatter(_) | UnitOp::Shade(_) | UnitOp::MaskMix(_))
    });
    if reads_field { PROGRAM_LENS } else { PROGRAM_NONE }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vello::units::UnitOp;

    fn warp() -> UnitOp { UnitOp::Warp(Vec::new()) }
    fn scatter() -> UnitOp { UnitOp::Scatter(Vec::new()) }
    fn shade() -> UnitOp { UnitOp::Shade(Vec::new()) }
    fn maskmix() -> UnitOp { UnitOp::MaskMix(Vec::new()) }
    fn tint() -> UnitOp { UnitOp::Tint(Vec::new()) }

    /// Sharp glass — the one fused arm `[Warp, Shade, MaskMix]` bakes to exactly the descriptor
    /// `wv_lens_fine_uniform`/`wv_fine_passes` emits today: bits 56.
    #[test]
    fn bits_of_reproduces_sharp_glass() {
        assert_eq!(bits_of(&[warp(), shade(), maskmix()]), bits::WARP | bits::SHADE | bits::MASKMIX);
        assert_eq!(bits_of(&[warp(), shade(), maskmix()]), 56, "the byte fine reads for sharp glass");
        assert_eq!(program_of(&[warp(), shade(), maskmix()]), PROGRAM_LENS);
    }

    /// A frost blur link — `Blur{linear:false}` mixes in sRGB and is an intermediate link, so with the
    /// materialize policy it is `BLUR|SRGB|MATERIALIZE` = 1600, exactly `wv_frost_passes`' blur bytes.
    #[test]
    fn arm_bits_reproduces_the_frost_blur_link() {
        let blur = UnitOp::Blur { sigma: 4.0, linear: false };
        let p = Policy { materialize: true, ..Policy::default() };
        assert_eq!(arm_bits(&[blur], p), bits::BLUR | bits::SRGB | bits::MATERIALIZE);
        assert_eq!(arm_bits(&[UnitOp::Blur { sigma: 4.0, linear: false }], p), 1600);
    }

    /// The two shadow-blur arms: a drop blurs its silhouette in LINEAR light (no SRGB) with SHADOW_EDGE,
    /// H materializes, V spreads. Reproduces `wv_shadow_plan`'s 2624 (H) and 2240 (V) byte-for-byte.
    #[test]
    fn arm_bits_reproduces_the_shadow_blur_arms() {
        let blur = || UnitOp::Blur { sigma: 6.0, linear: true };
        let h = arm_bits(&[blur()], Policy { materialize: true, shadow_edge: true, ..Policy::default() });
        let v = arm_bits(&[blur()], Policy { spread: true, shadow_edge: true, ..Policy::default() });
        assert_eq!(h, bits::BLUR | bits::MATERIALIZE | bits::SHADOW_EDGE);
        assert_eq!(h, 2624);
        assert_eq!(v, bits::BLUR | bits::SPREAD | bits::SHADOW_EDGE);
        assert_eq!(v, 2240);
    }

    /// The new fused frost tail — `[Scatter, Shade, MaskMix]` in ONE arm (the 4-arm frost), where the
    /// old fine split scatter (256|512) from the tail (8|16). This is the intended new byte: 280.
    #[test]
    fn bits_of_fuses_the_frost_tail() {
        assert_eq!(bits_of(&[scatter(), shade(), maskmix()]), bits::SCATTER | bits::SHADE | bits::MASKMIX);
        assert_eq!(bits_of(&[scatter(), shade(), maskmix()]), 280);
    }

    /// A background tint is one `[Tint]` stamp with no field; a background field is `[Tint, MaskMix]`
    /// over a radial ramp. Reproduces `bg_tint_desc`'s bits 4 and 20.
    #[test]
    fn bits_of_reproduces_the_background_tints() {
        assert_eq!(bits_of(&[tint()]), bits::TINT);
        assert_eq!(bits_of(&[tint()]), 4);
        assert_eq!(program_of(&[tint()]), PROGRAM_NONE, "a plain tint measures no field");
        assert_eq!(bits_of(&[tint(), maskmix()]), bits::TINT | bits::MASKMIX);
        assert_eq!(bits_of(&[tint(), maskmix()]), 20);
    }

    /// Structural ops carry no bit — they are never part of a fused fragment run.
    #[test]
    fn structural_ops_contribute_no_bits() {
        assert_eq!(bits_of(&[UnitOp::Rasterize, UnitOp::Reload, UnitOp::Compose]), 0);
    }

    /// End to end for one arm: take the REAL production lens lowering (`lens_graph` at device scale),
    /// pull its Warp/Shade/MaskMix unit uniforms, and confirm `arm_descriptor` of that run reproduces
    /// the exact 26-float descriptor the current sharp-glass path (`wv_fine_passes`) emits — bits 56,
    /// program lens, and the merged `units_uniform`. This locks the whole serialize (bits + program +
    /// uniform) against the shipping descriptor, on the host, before the emitter swap.
    #[test]
    fn arm_descriptor_reproduces_the_sharp_glass_descriptor() {
        use crate::effect_graph::{lens_graph, EffectPass, LensGeometry, UnitKind};
        use crate::kurbo::{Affine, Point};
        use crate::model::TileMode;

        let g = crate::model::Glass {
            surface_type: 1,
            bezel_width: 10.0,
            thickness: 1.0,
            refractive_index: 1.5,
            specular_angle: 0.0,
            specular_opacity: 0.5,
            specular_saturation: 1.0,
            chromatic_aberration: 0.2,
            splay: 0.0,
            tilt_angle: 0.0,
            edge_boost: 0.0,
            zoom: 1.0,
            blur: 0.0,
            frost: 0.0,
            acceptable_downscale: 1.0,
            tile_mode: TileMode::Decal,
        };
        let geom = LensGeometry { center: Point::new(100.0, 100.0), width: 80.0, height: 60.0, corner_radius: 10.0, is_circle: false };
        let passes = lens_graph(&g, geom, (200, 200), (0.0, 0.0), Affine::IDENTITY, 1.0);
        let u_of = |want: UnitKind| {
            passes
                .iter()
                .find_map(|p| match &p.pass {
                    EffectPass::Unit { op, u, .. } if *op == want => Some(u.clone()),
                    _ => None,
                })
                .expect("the lens chain has this unit")
        };
        // Sharp glass drops the identity scatter, so the fused arm is warp + shade + mask-mix.
        let run = vec![UnitOp::Warp(u_of(UnitKind::Warp)), UnitOp::Shade(u_of(UnitKind::Shade)), UnitOp::MaskMix(u_of(UnitKind::MaskMix))];
        let d = arm_descriptor(&run, Policy::default(), None);

        // The exact bytes the current path builds: d[0]=56, d[1]=1 (lens), d[2..26]=units_uniform.
        let mut want = [0.0f32; 26];
        want[0] = 56.0;
        want[1] = PROGRAM_LENS;
        want[2..26].copy_from_slice(&crate::vello::units::units_uniform(&run));
        assert_eq!(d, want, "arm_descriptor reproduces the shipping sharp-glass descriptor");
        // And the uniform is real geometry, not zeros — the device field made it through.
        assert!(d[2] > 0.0 && d[3] > 0.0, "backdrop resolution in slots 0/1 of the uniform");
    }
}
