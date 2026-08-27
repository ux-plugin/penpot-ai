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

/// The `bits` field (descriptor slot 0) — one flag per unit/mode the fine CMD_EFFECT arm branches on.
/// Mirrors the literals `fine.wgsl` tests (`fx_applyPointwise` + the CMD_EFFECT interpreter); named
/// here so a descriptor is assembled from `bits::WARP | bits::SHADE`, never a bare `56.0`.
pub mod bits {
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

/// Assign `eid` + `round_off` to a chained gather's ordered descriptors — the whole of the emitter's
/// old `mi < len-1 → DILATED else MASKED` / `z += 1` per-marker bookkeeping, as a pure function over
/// the descriptor list a planner already produced. Each pass runs one round later than the previous
/// (`round_off = i`); every intermediate link writes its scratch UNMASKED and so takes the dilated
/// [`EID_MATERIALIZE`] coverage, and only the final link composites masked with [`EID_MASKED`]. A
/// single-descriptor gather (a sharp lens) is therefore one masked arm at `round_off = 0`.
///
/// This is the piece that is genuinely NEW — the descriptor bytes come verbatim from the (unchanged,
/// pixel-trusted) planner. Keeping it pure is what lets it be proven on the host with no GPU.
#[must_use]
pub fn gather_chain(passes: Vec<[f32; 26]>) -> Vec<Baked> {
    let last = passes.len().saturating_sub(1);
    passes
        .into_iter()
        .enumerate()
        .map(|(i, params)| Baked {
            eid: if i < last { EID_MATERIALIZE } else { EID_MASKED },
            round_off: i as u32,
            params,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sharp lens is one fused arm: a single masked composite at the effect's base round.
    #[test]
    fn a_single_descriptor_gather_is_one_masked_arm() {
        let mut d = [0.0f32; 26];
        d[0] = (bits::WARP | bits::SHADE | bits::MASKMIX) as f32;
        d[1] = PROGRAM_LENS;
        let baked = gather_chain(vec![d]);
        assert_eq!(baked.len(), 1);
        assert_eq!(baked[0].eid, EID_MASKED, "the only link composites masked");
        assert_eq!(baked[0].round_off, 0);
        assert_eq!(baked[0].params, d, "the descriptor bytes pass through untouched");
        assert_eq!(baked[0].bits(), bits::WARP | bits::SHADE | bits::MASKMIX);
    }

    /// A frosted lens is five links — warp, blur-H, blur-V, scatter, tail. The first four materialize
    /// their scratch (dilated); the tail composites masked. Rounds step 0..5. This mirrors the exact
    /// eid/round layout `wv_frost_passes` + the old emitter produced, now derived, not reconstructed.
    #[test]
    fn a_five_link_chain_materializes_all_but_the_tail() {
        let passes: Vec<[f32; 26]> = (0..5)
            .map(|i| {
                let mut d = [0.0f32; 26];
                d[0] = i as f32; // distinct per link, so passthrough is checked positionally
                d
            })
            .collect();
        let baked = gather_chain(passes);
        assert_eq!(baked.len(), 5);
        let eids: Vec<u32> = baked.iter().map(|b| b.eid).collect();
        assert_eq!(eids, vec![EID_MATERIALIZE, EID_MATERIALIZE, EID_MATERIALIZE, EID_MATERIALIZE, EID_MASKED]);
        let rounds: Vec<u32> = baked.iter().map(|b| b.round_off).collect();
        assert_eq!(rounds, vec![0, 1, 2, 3, 4], "each link is one round after the previous");
        for (i, b) in baked.iter().enumerate() {
            assert_eq!(b.params[0], i as f32, "link {i}'s descriptor passed through in order");
        }
    }

    /// A background blur is the two-link case: H materializes to the draft, V composites masked. The
    /// same predicate as the five-link chain, no separate blur path.
    #[test]
    fn a_separable_blur_is_materialize_then_masked() {
        let baked = gather_chain(vec![[7.0; 26], [9.0; 26]]);
        assert_eq!(baked.len(), 2);
        assert_eq!(baked[0].eid, EID_MATERIALIZE);
        assert_eq!(baked[0].round_off, 0);
        assert_eq!(baked[1].eid, EID_MASKED);
        assert_eq!(baked[1].round_off, 1);
    }

    /// An empty chain bakes to nothing — a node whose gather declined fine (`wv_fine_passes` → None)
    /// contributes no markers, not a spurious masked arm.
    #[test]
    fn an_empty_chain_bakes_to_nothing() {
        assert!(gather_chain(Vec::new()).is_empty());
    }
}
