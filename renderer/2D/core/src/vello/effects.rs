//! Built-in **pointwise** effects authored as inline WGSL, run through the shared custom-shader
//! spread path — the concrete first case of "an effect is a graph node, and a pointwise effect is a
//! single fused `.wgsl`" (see the effect-graph discussion). Texture and noise are both spreads
//! (`reads_backdrop: false`): they read only the shape's own freshly-rendered body at `@binding(2)`,
//! so they inherit the sink's `custom_over_body` executor in *both* vello backends with no per-backend
//! code. Blur/gather stay built-in pass kinds; these stay WGSL, because one pointwise pass is already
//! their optimal form.
//!
//! ## Shared function, not shared pass
//! [`FRACTAL_NOISE_WGSL`] is `concat!`'d into both shaders, so texture and noise share the noise
//! *code* while each stays one fused pass (generate → use, all in registers, no texture round-trip).
//! This is exactly the reuse-at-the-function-level the fusion discussion landed on.
//!
//! ## Binding contract (the generic custom-shader layout — see `graph::build_custom_pipeline`)
//! `@binding(0)` uniform `array<vec4<f32>, N>` with the surface resolution in `u[0].xy` then the
//! packed params; `@binding(1)` the shared sampler; `@binding(2)` the shape's body. The effect
//! declares its exact `N` ([`CustomShader::param_vec4s`](crate::model::CustomShader::param_vec4s))
//! and the backend sizes the uniform to exactly that, so the buffer always matches the shader — no
//! param-count mismatch is possible.
//!
//! ## Parity scope (slice 1)
//! The fill *behaviour* matches Skia: texture **displaces** the body (fill included), it does not mask
//! it; noise colours the body with `apply_to_fill` selecting clip-to-fill vs overlay. What is *not*
//! yet matched is Skia's world-unit, zoom-invariant grain anchoring — `custom_over_body` hands the
//! shader only the surface resolution, so the grain here is anchored in the body surface's own pixel
//! space. Closing that gap needs a standard view uniform (device scale + surface world origin) injected
//! into the custom-shader contract; tracked as a follow-up. The noise *pattern* is also not
//! pixel-identical to Skia (a different fBm), by design — only the density→coverage/slot behaviour is.

use crate::model::CustomShader;

/// UI radius (0..100) → body-pixel displacement multiplier, mirroring render-wasm's `RADIUS_SCALE`.
pub const RADIUS_SCALE: f32 = 3.0;

/// Max noise slots, mirroring render-wasm's `MAX_NOISE_SLOTS`.
pub const MAX_NOISE_SLOTS: usize = 4;

/// Empirical fit of *this* WGSL fBm's output distribution (NOT Skia's — the calibration is per-noise).
/// [`fbm`](FRACTAL_NOISE_WGSL) sums 4 octaves at amplitudes 0.5·(0.5^k), so its mean sits near 0.46 and
/// its spread near 0.12. These drive the density→coverage threshold and the even slot split, the same
/// way render-wasm's `FRACTAL_NOISE_MU/SIGMA` do for Skia's `fractal_noise`. Placeholders until the
/// distribution can be measured on GPU output; tune both once a clean doc is available to verify.
const FRACTAL_NOISE_MU: f32 = 0.46;
const FRACTAL_NOISE_SIGMA: f32 = 0.12;

/// Shared noise field: a 4-octave value-noise fBm with four decorrelated channels. `r` drives coverage
/// and the X displacement, `g` the slot split and the Y displacement, `rgb` the prism hue. Each channel
/// has mean ≈ [`FRACTAL_NOISE_MU`], range ≈ `[0, 0.94)`. `concat!`'d into both effect shaders.
pub const FRACTAL_NOISE_WGSL: &str = crate::field::FIELD_NOISE;

/// The noise source these effect shaders splice in — [`crate::field::FIELD_NOISE`], the same text
/// the [`crate::field::FieldOp::Noise`] operator emits. Exposed so a test can assert the two paths
/// cannot drift apart.
#[must_use]
pub fn fractal_noise_wgsl() -> &'static str {
    FRACTAL_NOISE_WGSL
}


/// **Texture** = noise → displace, fused. Reads the body at `uv + (noise.rg - 0.5)·magnitude` so the
/// whole shape (fill included) warps coherently — Skia's "displaces pixels rather than masking them".
///
/// Uniform: `u[0] = (resX, resY, magnitudePx, grainDivisor)`, `u[1].x = clipToShape`.
pub const TEXTURE_WGSL: &str = concat!(
    r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 2>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var body: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}
"#,
    r#"
@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let res = u[0].xy;
    let mag = u[0].z;          // max per-axis shift, body pixels
    let grainDiv = max(u[0].w, 1.0);
    let clipToShape = u[1].x;

    let uv = pos.xy / res;
    let n = fractalNoise(pos.xy / grainDiv);
    // R→X, G→Y; centred so a ~0.5-mean field gives near-zero net drift.
    let disp = (vec2<f32>(n.r, n.g) - vec2<f32>(0.5, 0.5)) * mag;
    let warpedUV = uv + disp / res;

    // textureSample stays out of control flow (WGSL requires uniform control flow for it).
    let warped = textureSample(body, samp, warpedUV);
    let srcCoverage = textureSample(body, samp, uv).a;
    // clip_to_shape: keep only where the *original* position had shape content, so displaced pixels
    // don't bleed into the padding ring. Off: let the warp bleed (Skia's uncropped displacement_map).
    let clipped = warped * srcCoverage;
    return mix(warped, clipped, clipToShape);
}
"#
);

/// **Noise** = noise → threshold → slot colour → composite over the body, fused. `apply_to_fill`
/// selects SrcATop (clip to the fill's own alpha) vs SrcOver (overlay across the shape rect).
///
/// Uniform: `u[0]=(resX,resY,grainDivisor,applyToFill)`, `u[1]=(threshold,feather,slotCount,split1)`,
/// `u[2]=(split2,split3,kind0,kind1)`, `u[3]=(kind2,kind3,_,_)`, `u[4..8]=c0..c3` (straight RGBA).
pub const NOISE_WGSL: &str = concat!(
    r#"
@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 8>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var body: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let c = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u));
    return vec4<f32>(c * 2.0 - 1.0, 0.0, 1.0);
}

fn hsv2rgb(c: vec3<f32>) -> vec3<f32> {
    let ph = vec3<f32>(c.x + 1.0, c.x + 2.0 / 3.0, c.x + 1.0 / 3.0);
    let p = abs(fract(ph) * 6.0 - vec3<f32>(3.0));
    return c.z * mix(vec3<f32>(1.0), clamp(p - vec3<f32>(1.0), vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}
fn rgb2hue(c: vec3<f32>) -> f32 {
    let maxC = max(c.r, max(c.g, c.b));
    let minC = min(c.r, min(c.g, c.b));
    let d = maxC - minC;
    if (d < 0.0001) { return 0.0; }
    var h: f32;
    if (maxC == c.r) { h = (c.g - c.b) / d; }
    else if (maxC == c.g) { h = (c.b - c.r) / d + 2.0; }
    else { h = (c.r - c.g) / d + 4.0; }
    return fract(h / 6.0);
}
"#,
    r#"
fn slotColor(idx: i32, noiseRgb: vec3<f32>) -> vec4<f32> {
    var kind: f32;
    var col: vec4<f32>;
    if (idx == 0) { kind = u[2].z; col = u[4]; }
    else if (idx == 1) { kind = u[2].w; col = u[5]; }
    else if (idx == 2) { kind = u[3].x; col = u[6]; }
    else { kind = u[3].y; col = u[7]; }

    let raw = fract(noiseRgb * 3.0);
    let hue = rgb2hue(raw);
    let prism = hsv2rgb(vec3<f32>(hue, 1.0, 1.0));
    let rgb = select(col.rgb, prism, kind > 0.5);
    return vec4<f32>(rgb, col.a);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let res = u[0].xy;
    let grainDiv = max(u[0].z, 1.0);
    let applyToFill = u[0].w;
    let threshold = u[1].x;
    let feather = max(u[1].y, 0.0001);
    let slotCount = i32(u[1].z + 0.5);
    let split1 = u[1].w;
    let split2 = u[2].x;
    let split3 = u[2].y;

    let uv = pos.xy / res;
    let base = textureSample(body, samp, uv);
    let n = fractalNoise(pos.xy / grainDiv);

    // Coverage: soft threshold on n.r (softness widens the feather).
    let cov = smoothstep(threshold - feather, threshold + feather, n.r);

    // Slot selection on the independent n.g channel (int select — no textureSample inside).
    var idx = 0;
    if (slotCount >= 2 && n.g > split1) { idx = 1; }
    if (slotCount >= 3 && n.g > split2) { idx = 2; }
    if (slotCount >= 4 && n.g > split3) { idx = 3; }
    let slot = slotColor(idx, n.rgb);

    let outA = cov * slot.a;
    // SrcOver: noise over the body across the shape rect.
    let overRgb = slot.rgb * outA + base.rgb * (1.0 - outA);
    let overA = outA + base.a * (1.0 - outA);
    // SrcATop: noise only where the fill exists (clipped to the body's own alpha).
    let atopA = outA * base.a;
    let atopRgb = slot.rgb * atopA + base.rgb * (1.0 - atopA);

    let rgb = mix(overRgb, atopRgb, applyToFill);
    let a = mix(overA, base.a, applyToFill);
    return vec4<f32>(rgb, a);
}
"#
);

/// The full texture shader source (shared noise fn spliced in).
#[must_use]
pub fn texture_wgsl() -> String {
    splice_noise(TEXTURE_WGSL)
}

/// The full noise shader source (shared noise fn spliced in).
#[must_use]
pub fn noise_wgsl() -> String {
    splice_noise(NOISE_WGSL)
}

/// Append the shared `fractalNoise()` function to an effect module. WGSL is order-independent for
/// top-level `fn`s, so appending is fine and keeps the per-effect source readable.
fn splice_noise(module: &str) -> String {
    let mut s = String::with_capacity(module.len() + FRACTAL_NOISE_WGSL.len());
    s.push_str(module);
    s.push_str(FRACTAL_NOISE_WGSL);
    s
}

/// Build the spread [`CustomShader`] for a texture effect, or `None` when it is hidden / no-op.
/// `params` are packed to match [`TEXTURE_WGSL`]'s uniform layout (after the resolution the sink
/// prepends). `reach` is the page-space displacement extent so the spread surface is padded to hold
/// the warp.
#[must_use]
pub fn texture_shader(noise_size: f32, radius: f32, clip_to_shape: bool, hidden: bool) -> Option<CustomShader> {
    if hidden || radius <= 0.0 {
        return None;
    }
    let magnitude_px = radius * RADIUS_SCALE;
    let grain_divisor = noise_size.max(1.0);
    let params = vec![
        magnitude_px,
        grain_divisor,
        if clip_to_shape { 1.0 } else { 0.0 },
    ];
    Some(CustomShader {
        wgsl: texture_wgsl(),
        reach: magnitude_px,
        param_vec4s: 2,
        params,
        reads_backdrop: false,
        acceptable_downscale: 1.0,
    })
}

/// The texture effect as **units**, from the same `params` [`texture_shader`] packs — the param
/// order lives here, next to the packing, rather than being re-derived at the call site.
///
/// `w`/`h` are the surface the effect runs over.
#[must_use]
pub fn texture_units(params: &[f32], w: f32, h: f32) -> Vec<crate::effect_graph::GraphPass> {
    use crate::effect_graph::{EffectPass, GraphPass, Src, UnitKind};
    let magnitude = params.first().copied().unwrap_or(0.0);
    let grain_div = params.get(1).copied().unwrap_or(1.0);
    let clip = params.get(2).copied().unwrap_or(0.0) != 0.0;
    // Warp the body by a noise displacement, then optionally confine to the coverage it started from
    // (a sampling head + pointwise clip — one fused pass). The two share the noise field program.
    let program = std::rc::Rc::new(crate::effect_graph::texture_field_program());
    let mut u = vec![0.0_f32; 24];
    u[0] = w;
    u[1] = h;
    u[2] = magnitude;
    u[3] = grain_div;
    // Slot 21 is a flag, not a length — the scale solver leaves it alone.
    u[21] = f32::from(u8::from(clip));
    u[16] = 1.0;
    let unit = |op: UnitKind, reach: f32| EffectPass::Unit { op, field: program.clone(), u: u.clone(), reach };
    vec![
        GraphPass::new(unit(UnitKind::Warp, magnitude), vec![Src::Input(0)]),
        GraphPass::new(unit(UnitKind::ClipToSource, 0.0), vec![Src::Pass(0)]),
    ]
}

/// One noise slot decoded off the wire: `kind` (0 solid, 1 prism) and straight RGBA in `[0, 1]`.
pub struct NoiseSlot {
    pub kind: u8,
    pub rgba: [f32; 4],
}

/// Build the spread [`CustomShader`] for a noise effect, or `None` when hidden / slotless. Thresholds
/// and slot splits are computed here (CPU side, like render-wasm) against this fBm's calibrated
/// distribution and packed into `params` to match [`NOISE_WGSL`]'s uniform layout.
#[must_use]
pub fn noise_shader(
    slots: &[NoiseSlot],
    noise_size: f32,
    density: f32,
    softness: f32,
    apply_to_fill: bool,
    hidden: bool,
) -> Option<CustomShader> {
    if hidden || slots.is_empty() {
        return None;
    }
    let slot_count = slots.len().clamp(1, MAX_NOISE_SLOTS);
    let density = density.clamp(0.0, 1.0);

    let target_p_less = if slot_count <= 1 { 1.0 / (density + 1.0) } else { 1.0 - density };
    let threshold = percentile_threshold(target_p_less);

    let (split1, split2, split3) = match slot_count {
        2 => (percentile_threshold(1.0 / 2.0), 0.0, 0.0),
        3 => (percentile_threshold(1.0 / 3.0), percentile_threshold(2.0 / 3.0), 0.0),
        4 => (
            percentile_threshold(1.0 / 4.0),
            percentile_threshold(2.0 / 4.0),
            percentile_threshold(3.0 / 4.0),
        ),
        _ => (0.0, 0.0, 0.0),
    };

    let feather = softness.clamp(0.0, 1.0) * FRACTAL_NOISE_SIGMA;
    let grain_divisor = noise_size.max(1.0);

    let mut kinds = [0.0f32; MAX_NOISE_SLOTS];
    let mut colors = [[0.0f32; 4]; MAX_NOISE_SLOTS];
    for (i, s) in slots.iter().take(MAX_NOISE_SLOTS).enumerate() {
        kinds[i] = f32::from(s.kind);
        colors[i] = s.rgba;
    }

    let mut params = vec![
        grain_divisor,
        if apply_to_fill { 1.0 } else { 0.0 },
        threshold,
        feather,
        slot_count as f32,
        split1,
        split2,
        split3,
        kinds[0],
        kinds[1],
        kinds[2],
        kinds[3],
        0.0,
        0.0,
    ];
    for c in colors {
        params.extend_from_slice(&c);
    }

    Some(CustomShader {
        wgsl: noise_wgsl(),
        reach: 0.0,
        param_vec4s: 8,
        params,
        reads_backdrop: false,
        acceptable_downscale: 1.0,
    })
}

/// Threshold `t` with `P(noise.r < t) ≈ cdf_target` under this fBm's `N(MU, SIGMA)` approximation.
/// Pixels with `noise.r >= t` become colored (coverage ≈ `1 - cdf_target`). Mirrors render-wasm's
/// `percentile_threshold`, retuned to [`FRACTAL_NOISE_MU`]/[`FRACTAL_NOISE_SIGMA`].
fn percentile_threshold(cdf_target: f32) -> f32 {
    (FRACTAL_NOISE_MU + FRACTAL_NOISE_SIGMA * normal_inv_cdf(cdf_target)).clamp(0.0, 1.0)
}

/// Peter Acklam's inverse standard-normal CDF (ported verbatim from render-wasm's `render::noise`).
fn normal_inv_cdf(p: f32) -> f32 {
    let p = f64::from(p).clamp(1e-6, 1.0 - 1e-6);
    const A: [f64; 6] = [
        -3.969_683_028_665_376e1,
        2.209_460_984_245_205e2,
        -2.759_285_104_469_687e2,
        1.383_577_518_672_69e2,
        -3.066_479_806_614_716e1,
        2.506_628_277_459_239e0,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e1,
        1.615_858_368_580_409e2,
        -1.556_989_798_598_866e2,
        6.680_131_188_771_972e1,
        -1.328_068_155_288_572e1,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_293e-3,
        -3.223_964_580_411_365e-1,
        -2.400_758_277_161_838e0,
        -2.549_732_539_343_734e0,
        4.374_664_141_464_968e0,
        2.938_163_982_698_783e0,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-3,
        3.224_671_290_700_398e-1,
        2.445_134_137_142_996e0,
        3.754_408_661_907_416e0,
    ];
    const P_LOW: f64 = 0.02425;
    const P_HIGH: f64 = 1.0 - P_LOW;

    let z = if p < P_LOW {
        let q = (-2.0 * p.ln()).sqrt();
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    } else if p <= P_HIGH {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    } else {
        let q = (-2.0 * (1.0 - p).ln()).sqrt();
        -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    };
    z as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(src: &str) {
        let module = naga::front::wgsl::parse_str(src)
            .unwrap_or_else(|e| panic!("WGSL parse failed: {}", e.emit_to_string(src)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("WGSL validation failed: {e:?}"));
    }

    #[test]
    fn texture_wgsl_compiles() {
        validate(&texture_wgsl());
    }

    #[test]
    fn noise_wgsl_compiles() {
        validate(&noise_wgsl());
    }

    #[test]
    fn texture_shader_packs_expected_params() {
        let s = texture_shader(20.0, 10.0, true, false).expect("visible texture");
        assert!(!s.reads_backdrop, "texture is a spread");
        assert_eq!(s.params, vec![30.0, 20.0, 1.0]);
        assert!((s.reach - 30.0).abs() < 1e-6);
    }

    #[test]
    fn hidden_or_zero_radius_texture_is_none() {
        assert!(texture_shader(20.0, 0.0, false, false).is_none());
        assert!(texture_shader(20.0, 10.0, false, true).is_none());
    }

    #[test]
    fn noise_shader_packs_eight_vec4s() {
        let slots = vec![
            NoiseSlot { kind: 0, rgba: [1.0, 0.0, 0.0, 1.0] },
            NoiseSlot { kind: 1, rgba: [0.0, 0.0, 0.0, 0.5] },
        ];
        let s = noise_shader(&slots, 16.0, 0.5, 0.3, true, false).expect("visible noise");
        assert!(!s.reads_backdrop, "noise is a spread");
        assert_eq!(s.params.len(), 30);
        assert_eq!((2 + s.params.len()) % 4, 0);
    }

    #[test]
    fn hidden_or_slotless_noise_is_none() {
        assert!(noise_shader(&[], 16.0, 0.5, 0.3, false, false).is_none());
        let slots = vec![NoiseSlot { kind: 0, rgba: [1.0; 4] }];
        assert!(noise_shader(&slots, 16.0, 0.5, 0.3, false, true).is_none());
    }
}
