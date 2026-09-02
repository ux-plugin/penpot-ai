//! `bake` — the ONE place an effect becomes the fine descriptors that run it.
//!
//! Today the whole-viewport emitter (`render_whole_viewport`) reconstructs, per effect kind, both the
//! descriptor bytes AND the scaffolding around them: `stack_markers`/`fx_markers`/`fx_offset` maps, the
//! `ShadowRole`-driven `eid` choice, and the intra-effect round layout (`schedule_shadows`, the frost
//! five-round block). That scaffolding exists only to reconcile four per-effect planners against one
//! marker stream. `bake` dissolves it: it owns the effect→descriptor encoding (`arm_descriptor`,
//! `blur_arm`), so the scheduler's emitter (`FrameDag::arms_for`) is a flat loop over `frame_dag`'s
//! markers — each descriptor already carrying its `eid` and its round offset.
//!
//! The descriptor is the seam `fine.wgsl` reads: `[bits, program, 6×vec4 u]` = 26 floats, packed into
//! `effect_params` at the offset the marker carries. `bits` selects the head + pointwise tail + the
//! composite mode; `program` selects the field ([`PROGRAM_ROUNDED_BOX`] / [`PROGRAM_RADIAL`]); `u` is the
//! `units_uniform` the field and its units read. This module owns that vocabulary so both the current
//! `fine.wgsl` and the clean `new_fine.wgsl` read one definition of it.
//!
//! # The operand-list contract (normative — the target ABI)
//!
//! An arm's inputs are ONE encoding at every size: a list of fixed-stride records in
//! `effect_params`, addressed by `(offset, count)` in the descriptor header. Record `i` is input
//! `i` of the op — position is identity, the compiled mirror of the DAG node's `inputs` vec. Each
//! record stores only SOURCE facts (register code, window origin, per-source params such as an SDF
//! decode); types are fixed by `(op, index)` at the op's definition and never stored. The kernel
//! reads record `i` at `offset + i * STRIDE` — indexed, never scanned; `(offset, count)` is the
//! single permitted indirection per arm, an index into the same buffer, never a chain.
//!
//! The current encoding — operand bits 15..19 in the header plus unit-specific window slots — is
//! the pre-migration form of this contract and is retired by the migration, not extended. New
//! operand kinds go into records, never into new named bits.

use crate::vello::units::UnitOp;

/// The `bits` field (descriptor slot 0) — one flag per unit/mode the fine CMD_EFFECT arm branches on.
/// Mirrors the literals `fine.wgsl` tests (`fx_applyPointwise` + the CMD_EFFECT interpreter); named
/// here so a descriptor is assembled from `bits::WARP | bits::SHADE`, never a bare `56.0`. Bits 15+
/// are free: the arm's operands live in the record table after the header (see [`super::REC_STRIDE`])
/// and operand facts never return to this word.
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
    /// Sampling head: jittered read of the input — stochastic diffusion, the sampling-head analogue
    /// of a blur.
    pub const SCATTER: u32 = 256;
    /// Text inner flood: recover unoffset glyph coverage from the offset silhouette.
    pub const FLOOD_ERASE: u32 = 4096;
    /// COMPOSE MODE — how the arm's result lands, a one-hot enum over three bits (all clear = the
    /// default field/coverage-masked mix). Mutually exclusive by construction: an arm composites one
    /// way. `COLOUR_OVER` (bit 7): the value is a COVERAGE — lay the straight colour in `u[3]`
    /// through it, source-over. `RAW` (bit 9): no composite at all — write the value as-is to the
    /// scratch (an intermediate link whose consumer reads the full field). `VALUE_OVER` (bit 14):
    /// the value is premultiplied RGBA — source-over as-is, its own alpha is the coverage.
    pub const COLOUR_OVER: u32 = 128;
    /// See [`COLOUR_OVER`] — the write-through compose mode.
    pub const RAW: u32 = 512;
    /// See [`COLOUR_OVER`] — the premultiplied source-over compose mode.
    pub const VALUE_OVER: u32 = 16384;
}

/// The number of operand records every arm carries after its 26-float header.
pub const REC_COUNT: usize = 5;
/// Floats per operand record: `[source, window x, window y, param]`. Record `i` sits at
/// `off + 26 + i * REC_STRIDE`. Roles: record 0 = the VALUE the arm transforms, record 1 = the
/// REFERENCE (`orig`) binary pointwise units compare against, record 2 = the composite's COVERAGE,
/// record 3 = the FIELD's distance input, record 4 = the arm's OUTPUT. Source codes are role-typed:
/// 0 = default (backdrop / `area[i]` / generated / the accumulator), 2 = the input register (a
/// source, draft, scratch, or baked SDF); for the OUTPUT record, 1 = a reach-cropped scratch lease;
/// the window is the operand's coordinate-frame origin in device px (a texture region's start, a
/// generated field's anchor, or the lease origin the store shifts by); param is per-source (an SDF
/// decode range).
pub const REC_STRIDE: usize = 4;

/// The FIELD operand's MATH (`program`, slot 1) — which analytic assembly the arm's field runs.
/// The field's distance INPUT is a separate, ordinary operand-table fact (operand 3: generated by
/// this program's own shape, or read from the input register — a baked SDF the DAG wires as a real
/// edge), so "sampled" is not a program: it is the same math over a different distance source.
/// Named by the math, never by an effect; any unit may measure any field. `0` = the arm has no
/// field operand.
pub const PROGRAM_NONE: f32 = 0.0;
/// The rounded-box signed-distance field, with refraction/specular outputs.
pub const PROGRAM_ROUNDED_BOX: f32 = 1.0;
/// The fractal-noise displacement field.
pub const PROGRAM_NOISE: f32 = 2.0;
/// The radial-ramp field (mask fades from the silhouette centre).
pub const PROGRAM_RADIAL: f32 = 3.0;

/// The `effect_id` a marker carries — both are `>= EFFECT_INLINE_BASE`, so `fine` runs the descriptor
/// inline. They differ only in coverage: [`EID_MASKED`] keeps the rasterised silhouette (`area[i]`) so
/// the final composite is clipped to the shape's outline; [`EID_MATERIALIZE`] uses the dilated reach
/// rect so an intermediate link writes its full field to scratch without clipping.
pub const EID_MASKED: u32 = 100;
/// A materialize/dilated marker — an intermediate gather link, or a spread laid over the dilated reach.
pub const EID_MATERIALIZE: u32 = 101;

/// The per-arm facts that come from POSITION and compose-mode, not from the units — derivable at
/// bake time from the chain, never a stored tag. `colour_over`/`raw`/`value_over` select the
/// compose mode (see [`bits::COLOUR_OVER`]); `edge_coverage` is the blur's out-of-bounds
/// assumption (taps past the crop read transparent 0, not the page) — a `Blur` payload fact, not a
/// bit (see [`PAYLOAD_BLUR_EDGE_SLOT`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub colour_over: bool,
    pub raw: bool,
    pub edge_coverage: bool,
    pub value_over: bool,
}

/// Map a fused unit run to the descriptor's `bits` word — the ONE genuinely-new derivation of the bake
/// rebase, and pure. Each unit sets its own flag: a sampling head (`Warp`/`Scatter`), a `Blur` (with
/// gamma-space mix riding its payload), and the pointwise tail (`Shade`/`MaskMix`/`Tint`/`Clip`/
/// `Erase`). Structural ops never appear in
/// a run. Whether a trailing `Tint` is a `TINT` pointwise (a backdrop tint) or the colour of a `SPREAD`
/// composite (a shadow) is decided by arm-GROUPING upstream — a spread arm's run is the gather alone,
/// its colour riding `u[3]` — so `bits_of` needs no compose context.
#[must_use]
pub fn bits_of(run: &[UnitOp]) -> u32 {
    run.iter().fold(0u32, |b, u| {
        b | match u {
            UnitOp::Warp(_) => bits::WARP,
            UnitOp::Scatter(_) => bits::SCATTER,
            UnitOp::Blur { .. } => bits::BLUR,
            UnitOp::Shade(_) => bits::SHADE,
            UnitOp::MaskMix(_) => bits::MASKMIX,
            UnitOp::Colour(_) => bits::TINT,
            UnitOp::ClipToSource(_) => bits::CLIP,
            UnitOp::EraseBy(_) => bits::ERASE,
            UnitOp::Rasterize(_) | UnitOp::Reload | UnitOp::Compose { .. } => 0,
        }
    })
}

/// Flat payload slot 12 (`u[2].z`): a `Blur` mixes in sRGB (non-zero) rather than linear light.
pub const PAYLOAD_BLUR_SRGB_SLOT: usize = 12;
/// Flat payload slot 13 (`u[2].w`): a `Blur`'s out-of-bounds taps read transparent 0 (a coverage
/// blur) rather than the page (a backdrop blur).
pub const PAYLOAD_BLUR_EDGE_SLOT: usize = 13;

/// The complete `bits` word for one arm: its unit-derived bits plus the compose mode.
#[must_use]
pub fn arm_bits(run: &[UnitOp], p: Policy) -> u32 {
    bits_of(run)
        | if p.colour_over { bits::COLOUR_OVER } else { 0 }
        | if p.raw { bits::RAW } else { 0 }
        | if p.value_over { bits::VALUE_OVER } else { 0 }
}

/// Serialize one fused arm to the 26-float descriptor `fine` reads: `bits` (slot 0) from `arm_bits`,
/// `program` (slot 1) from `program_of` unless the effect overrode it, and the merged unit uniform
/// (slots 2..26) from [`crate::vello::units::units_uniform`]. This is the whole "serialize" step — a
/// pure function over units the scheduler already filled, replacing the four planners' descriptor
/// assembly. `program` is `Some` when the effect fixes the field (radial for a background field), else
/// derived from the run.
/// Flat payload slot 22 (`u[5].z`): a unit's DECLARED field program, stamped at lowering. Zero means
/// undeclared — the legacy warp⇒lens fallback ([`program_of`]) applies. This is how a run says which
/// field it measures without anything downstream classifying the chain.
pub const PAYLOAD_PROGRAM_SLOT: usize = 22;

#[must_use]
pub fn arm_descriptor(run: &[UnitOp], policy: Policy, program: Option<f32>) -> [f32; 26] {
    let mut d = [0.0f32; 26];
    let u = crate::vello::units::units_uniform(run);
    d[0] = arm_bits(run, policy) as f32;
    d[1] = if u[PAYLOAD_PROGRAM_SLOT] != 0.0 {
        u[PAYLOAD_PROGRAM_SLOT]
    } else {
        program.unwrap_or_else(|| program_of(run))
    };
    d[2..26].copy_from_slice(&u);
    d
}

/// Serialize ONE separable-blur axis pass to the 26-float descriptor `fine` reads — the single place
/// a `Blur` unit becomes bytes, shared by every path that emits one (the fx_fine background blur, a
/// soft shadow's H/V). `units_uniform` deliberately skips `Blur` (a barrier carries no fused uniform),
/// so its `u[0]` is written here: `axis` in slots 2/3 (X pass = `(1,0)`, Y pass = `(0,1)`) and the
/// device `sigma` in slot 4. `bits` is `BLUR` plus the compose mode; the gamma-space mix and the
/// out-of-bounds edge policy ride the blur's own payload (slots 12/13).
/// `tint` rides `u[3]` (slots 14..18) for a `spread` arm that lays a straight colour — a shadow's V
/// pass — and is `None` for a plain draft blur.
#[must_use]
pub fn blur_arm(sigma: f32, linear: bool, axis_y: bool, policy: Policy, tint: Option<[f32; 4]>) -> [f32; 26] {
    let mut d = [0.0f32; 26];
    d[0] = (bits::BLUR
        | if policy.raw { bits::RAW } else { 0 }
        | if policy.colour_over { bits::COLOUR_OVER } else { 0 }
        | if policy.value_over { bits::VALUE_OVER } else { 0 }) as f32;
    d[2] = f32::from(!axis_y); // u[0].x
    d[3] = f32::from(axis_y); // u[0].y
    d[4] = sigma; // u[0].z = device sigma
    d[PAYLOAD_BLUR_SRGB_SLOT] = f32::from(!linear);
    d[PAYLOAD_BLUR_EDGE_SLOT] = f32::from(policy.edge_coverage);
    if let Some([r, g, b, a]) = tint {
        d[14] = r; // u[3] = straight spread colour
        d[15] = g;
        d[16] = b;
        d[17] = a;
    }
    d
}

/// Serialize a SPREAD composite arm — a shadow that lays a straight colour source-OVER the accumulator
/// with no blur of its own: a sharp drop (the offset silhouette), a sharp/soft inner band (flood minus
/// punch). `bits` is `SPREAD` plus the `coverage` bit that says where the arm's alpha comes from —
/// [`bits::operand(2)`] (a precomputed scratch coverage, e.g. the sink-rasterised offset silhouette or
/// a text flood) or [`bits::ERASE`] (flood `area[i]` minus the punch) — and the straight `colour` rides
/// `u[3]` (slots 14..18). This is the non-blur companion to [`blur_arm`]; a soft shadow's blur passes
/// use `blur_arm`, its final colour composite uses this.
#[must_use]
pub fn spread_arm(coverage: u32, colour: [f32; 4]) -> [f32; 26] {
    let mut d = [0.0f32; 26];
    d[0] = (bits::COLOUR_OVER | coverage) as f32;
    d[14..18].copy_from_slice(&colour);
    d
}

/// Serialize ONE unit to the 26-float descriptor `fine` reads — the atomic contract: one `UnitOp`, one
/// descriptor, no fusion. `bits` (slot 0) is this unit's single flag plus its `policy`; `program` (slot
/// 1) is the field it measures; slots 2..26 are its own uniform. Composition is NOT here — the PTCL
/// sequences these atomic descriptors and `fine` chains them in registers, so a shadow's colour is its
/// own `Tint` marker rather than a `tint` folded into the blur. A `Blur` packs its axis/sigma into
/// `u[0]` (the uniform skips it), every other unit rides its own uniform slots.
#[must_use]
pub fn bake_unit(op: &UnitOp, policy: Policy) -> [f32; 26] {
    match *op {
        UnitOp::Blur { sigma, linear, axis, .. } => {
            blur_arm(sigma, linear, axis == crate::vello::units::BlurAxis::Y, policy, None)
        }
        _ => arm_descriptor(std::slice::from_ref(op), policy, None),
    }
}

/// Stamp a descriptor's field ANCHOR into operand record 3 (`rec[3].yz`) — the device point the
/// program measures its field relative to. WHERE the anchor lives in the uniform is each program's
/// declared fact ([`crate::vello::fine_field::programs`], the source's centre slot), so this is a
/// table lookup, never a per-program branch; a program with no anchor (or no field at all) leaves
/// the record untouched.
pub fn stamp_field_anchor(desc: &[f32; 26], rec: &mut [[f32; 4]; 5]) {
    static ANCHORS: std::sync::OnceLock<Vec<(u32, usize)>> = std::sync::OnceLock::new();
    let table = ANCHORS.get_or_init(|| {
        crate::vello::fine_field::programs()
            .iter()
            .filter_map(|e| {
                e.anchor.map(|s| (e.id, 2 + 4 * usize::from(s.vec4) + usize::from(s.comp)))
            })
            .collect()
    });
    let id = desc[1] as u32;
    if let Some(&(_, i)) = table.iter().find(|&&(p, _)| p == id) {
        rec[3][1] = desc[i];
        rec[3][2] = desc[i + 1];
    }
}

/// The field program a run measures: a lens field when any unit reads it (a head or a field-measuring
/// pointwise), else no field (a plain stamp). A radial/sampled/custom field is set by the effect at
/// bake time — this covers the common lens case.
#[must_use]
pub fn program_of(run: &[UnitOp]) -> f32 {
    let reads_field = run.iter().any(|u| {
        matches!(u, UnitOp::Warp(_) | UnitOp::Scatter(_) | UnitOp::Shade(_) | UnitOp::MaskMix(_))
    });
    if reads_field { PROGRAM_ROUNDED_BOX } else { PROGRAM_NONE }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vello::units::UnitOp;

    fn warp() -> UnitOp { UnitOp::Warp(Vec::new()) }
    fn scatter() -> UnitOp { UnitOp::Scatter(Vec::new()) }
    fn shade() -> UnitOp { UnitOp::Shade(Vec::new()) }
    fn maskmix() -> UnitOp { UnitOp::MaskMix(Vec::new()) }
    fn colour() -> UnitOp { UnitOp::Colour(Vec::new()) }

    /// Sharp glass — the one fused arm `[Warp, Shade, MaskMix]` bakes to exactly the descriptor
    /// `wv_lens_fine_uniform`/`wv_fine_passes` emits today: bits 56.
    #[test]
    fn bits_of_reproduces_sharp_glass() {
        assert_eq!(bits_of(&[warp(), shade(), maskmix()]), bits::WARP | bits::SHADE | bits::MASKMIX);
        assert_eq!(bits_of(&[warp(), shade(), maskmix()]), 56, "the byte fine reads for sharp glass");
        assert_eq!(program_of(&[warp(), shade(), maskmix()]), PROGRAM_ROUNDED_BOX);
    }

    /// The atomic contract: one unit bakes to a descriptor carrying only its own bit — no fusion. Three
    /// units that would fuse to bits 56 become three descriptors of bits 32, 8, 16, which the PTCL
    /// sequences and `fine` chains.
    #[test]
    fn bake_unit_is_one_bit_per_descriptor() {
        assert_eq!(bake_unit(&warp(), Policy::default())[0] as u32, bits::WARP);
        assert_eq!(bake_unit(&shade(), Policy::default())[0] as u32, bits::SHADE);
        assert_eq!(bake_unit(&maskmix(), Policy::default())[0] as u32, bits::MASKMIX);
        assert_eq!(bake_unit(&colour(), Policy::default())[0] as u32, bits::TINT);
        let blur = UnitOp::Blur { sigma: 6.0, linear: true, axis: Default::default(), edge: Default::default() };
        let d = bake_unit(&blur, Policy { edge_coverage: true, ..Policy::default() });
        assert_eq!(d[0] as u32, bits::BLUR);
        assert_eq!(d[PAYLOAD_BLUR_EDGE_SLOT], 1.0, "edge policy rides the blur payload, not a bit");
    }

    /// A frost blur link — `Blur{linear:false}` mixes in sRGB (payload slot 12) and is an
    /// intermediate link (the RAW compose mode).
    #[test]
    fn arm_bits_reproduces_the_frost_blur_link() {
        let p = Policy { raw: true, ..Policy::default() };
        let d = blur_arm(4.0, false, false, p, None);
        assert_eq!(d[0] as u32, bits::BLUR | bits::RAW);
        assert_eq!(d[PAYLOAD_BLUR_SRGB_SLOT], 1.0, "gamma-space mix rides the blur payload");
    }

    /// The two shadow-blur arms: a drop blurs its silhouette in LINEAR light over a coverage edge,
    /// H writes RAW, V lays the colour over.
    #[test]
    fn arm_bits_reproduces_the_shadow_blur_arms() {
        let p = |raw, colour_over| Policy { raw, colour_over, edge_coverage: true, ..Policy::default() };
        let h = blur_arm(6.0, true, false, p(true, false), None);
        let v = blur_arm(6.0, true, true, p(false, true), None);
        assert_eq!(h[0] as u32, bits::BLUR | bits::RAW);
        assert_eq!(v[0] as u32, bits::BLUR | bits::COLOUR_OVER);
        assert_eq!((h[PAYLOAD_BLUR_EDGE_SLOT], v[PAYLOAD_BLUR_EDGE_SLOT]), (1.0, 1.0));
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
        assert_eq!(bits_of(&[colour()]), bits::TINT);
        assert_eq!(bits_of(&[colour()]), 4);
        assert_eq!(program_of(&[colour()]), PROGRAM_NONE, "a plain tint measures no field");
        assert_eq!(bits_of(&[colour(), maskmix()]), bits::TINT | bits::MASKMIX);
        assert_eq!(bits_of(&[colour(), maskmix()]), 20);
    }

    /// `blur_arm` is the ONE serializer for every axis pass. It reproduces both conventions byte-for-byte:
    /// the emitter-driven fx_fine background blur (plain BLUR(64), axis + sigma, no policy/colour) and the
    /// baked soft-drop shadow arms (`wv_shadow_plan`'s H = 2624, V = 2240 + straight colour).
    #[test]
    fn blur_arm_reproduces_both_conventions() {
        // fx_fine background blur: two plain-BLUR axis passes, linear, no policy, no colour.
        let h = blur_arm(3.0, true, false, Policy::default(), None);
        let v = blur_arm(3.0, true, true, Policy::default(), None);
        assert_eq!([h[0], h[2], h[3], h[4]], [64.0, 1.0, 0.0, 3.0], "H = BLUR, axis X, sigma");
        assert_eq!([v[0], v[2], v[3], v[4]], [64.0, 0.0, 1.0, 3.0], "V = BLUR, axis Y, sigma");

        // Soft-drop shadow: linear silhouette blur, H materializes a draft, V spreads the colour under
        // the body — both SHADOW_EDGE. Byte-identical to wv_shadow_plan's hand-built descriptors.
        let colour = [0.1, 0.2, 0.3, 0.8];
        let sh = blur_arm(6.0, true, false, Policy { raw: true, edge_coverage: true, ..Policy::default() }, None);
        let sv = blur_arm(6.0, true, true, Policy { colour_over: true, edge_coverage: true, ..Policy::default() }, Some(colour));
        assert_eq!(sh[0], (bits::BLUR | bits::RAW) as f32, "H = BLUR, RAW compose");
        assert_eq!([sh[2], sh[3], sh[4]], [1.0, 0.0, 6.0], "H axis + sigma");
        assert_eq!(sv[0], (bits::BLUR | bits::COLOUR_OVER) as f32, "V = BLUR, colour-over compose");
        assert_eq!([sv[2], sv[3], sv[4]], [0.0, 1.0, 6.0], "V axis + sigma");
        assert_eq!([sv[14], sv[15], sv[16], sv[17]], colour, "V carries the straight shadow colour in u[3]");
    }

    /// `spread_arm` reproduces the non-blur composites: a sharp drop / text inner band (colour-over
    /// with the scratch coverage operand) and a sharp/soft inner band (colour-over + erase), colour
    /// in u[3].
    #[test]
    fn spread_arm_reproduces_the_shadow_composites() {
        let colour = [0.4, 0.5, 0.6, 0.7];
        let scratch = spread_arm(0, colour);
        assert_eq!(scratch[0] as u32, bits::COLOUR_OVER, "colour-over; the scratch coverage rides record 2");
        assert_eq!([scratch[14], scratch[15], scratch[16], scratch[17]], colour, "straight colour in u[3]");
        let erase = spread_arm(bits::ERASE, colour);
        assert_eq!(erase[0] as u32, bits::COLOUR_OVER | bits::ERASE, "colour-over + erase (inner band: flood minus punch)");
        assert_eq!([erase[14], erase[15], erase[16], erase[17]], colour);
    }

    /// Structural ops carry no bit — they are never part of a fused fragment run.
    #[test]
    fn structural_ops_contribute_no_bits() {
        assert_eq!(bits_of(&[UnitOp::Rasterize(crate::vello::units::RasterSource::Body { offset: [0.0; 2] }), UnitOp::Reload, UnitOp::Compose { mode: Default::default(), colour: None }]), 0);
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
        want[1] = PROGRAM_ROUNDED_BOX;
        want[2..26].copy_from_slice(&crate::vello::units::units_uniform(&run));
        assert_eq!(d, want, "arm_descriptor reproduces the shipping sharp-glass descriptor");
        // And the uniform is real geometry, not zeros — the device field made it through.
        assert!(d[2] > 0.0 && d[3] > 0.0, "backdrop resolution in slots 0/1 of the uniform");
    }
}
