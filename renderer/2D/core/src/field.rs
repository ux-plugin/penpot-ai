//! Signed distance fields as a first-class effect value.
//!
//! A *field* is a scalar defined at every pixel — the signed distance to a shape's edge, negative
//! inside. It is the quantity a surprising number of effects are actually written against: a mask is
//! the field thresholded, a stroke is a band around zero, a spread is the threshold moved, a bevel is
//! the near-edge distance pushed through a curve, and a lens is that same curve turned into a
//! refraction. Each of those was implemented separately, each carrying its own copy of the
//! geometry-to-pixels step; this module is that step, named once.
//!
//! Two things are separated on purpose:
//!
//! - **Where the field comes from** ([`FieldSource`]) — analytic for shapes with a closed form, or a
//!   baked texture for arbitrary geometry. This is the only part that knows about shapes, and it is
//!   where the recompute-versus-store question lives: a field defined by a handful of parameters is
//!   cheaper to re-derive per pixel than to fetch, and stays exact at any zoom, so it is never
//!   stored; a field defined by a path cannot be compressed to parameters, so it is materialised
//!   once per shape and cached across frames. Same rule for a stroke, a bevel or a lens.
//! - **What is done with it** ([`FieldOp`]) — pure per-pixel arithmetic that never asks what shape it
//!   came from, so every operator serves every source.
//!
//! A [`FieldProgram`] is a small straight-line DAG of those operators that lowers to WGSL
//! ([`FieldProgram::wgsl`]). It is *fused*, never materialised: a program produces values in
//! registers inside whatever pass consumes them, which is why it is not a
//! [`crate::effect_graph::GraphPass`].
//!
//! Parameters are read from the consumer's own uniform through [`Slot`], so a program never dictates
//! a uniform layout — it borrows the one its consumer already has.

/// Where a field's distance comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldSource {
    /// Analytic rounded box: centre at `centre`, half-extents at `half`, corner radius at `corner`
    /// (clamped to the smaller half-extent, so an over-large radius degenerates to a stadium rather
    /// than inverting). Costs no memory and stays exact at any zoom, so it is re-derived per pixel.
    RoundedBox { centre: Slot2, half: Slot2, corner: Slot },
    /// Distance read from a **baked** field — the source for geometry with no closed form: paths,
    /// text, boolean results, anything a designer draws by hand. `centre` and `half` still describe
    /// the bake's box, so the operators that clamp to the shape work unchanged; `decode` maps the
    /// stored value back to pixels.
    ///
    /// The consumer binds the texture as `fieldTex` alongside its sampler. Unlike the analytic
    /// source this one cannot be re-derived per pixel — the path *is* the parameter — so it is baked
    /// once per shape and cached across frames.
    Sampled { centre: Slot2, half: Slot2, decode: Slot },
}

/// A reference to one scalar in the consumer's uniform: `vec4` index and component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub vec4: u8,
    pub comp: u8,
}

/// A reference to two adjacent scalars in the consumer's uniform — a point or extent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot2 {
    pub vec4: u8,
    /// Component of the first scalar; the second is the next one along.
    pub comp: u8,
}

impl Slot {
    #[must_use]
    pub const fn new(vec4: u8, comp: u8) -> Self {
        Self { vec4, comp }
    }

    fn wgsl(self) -> String {
        format!("fieldU(gi, {}u).{}", self.vec4, "xyzw".as_bytes()[self.comp as usize] as char)
    }
}

impl Slot2 {
    #[must_use]
    pub const fn new(vec4: u8, comp: u8) -> Self {
        Self { vec4, comp }
    }

    fn wgsl(self) -> String {
        let c = "xyzw".as_bytes();
        format!(
            "fieldU(gi, {}u).{}{}",
            self.vec4, c[self.comp as usize] as char, c[self.comp as usize + 1] as char
        )
    }
}

/// A node's input: an earlier node's value, or the pixel's position in field space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldRef {
    /// The pixel offset from the field's centre — what the source measured distance from.
    Local,
    /// The value produced by node `usize`.
    Node(usize),
}

/// One operator over a field. Everything here is per-pixel arithmetic on a scalar (or a direction)
/// and is blind to the geometry that produced it, which is what lets one implementation serve the
/// analytic and the baked source alike.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldOp {
    /// The signed distance itself — the root of every program.
    Distance(FieldSource),
    /// Distance to a normalised edge parameter: `clamp(-d / edge, 0, 1)`, so `0` at the edge and `1`
    /// once `edge` pixels inside. The unit every inward profile is expressed against.
    Ramp { d: FieldRef, edge: Slot, clamp_edge_to_extent: bool },
    /// The edge parameter through a surface-height curve — the bevel's cross-section. `kind` picks
    /// the profile (circular, quartic, inverted quartic, or an S-blend of the last two).
    Profile { t: FieldRef, kind: Slot },
    /// The slope of [`FieldOp::Profile`] at the same parameter, by central difference.
    ProfileSlope { t: FieldRef, kind: Slot },
    /// Distance to antialiased coverage: `smoothstep(0, softness, -d)`. This *is* a mask.
    Coverage { d: FieldRef, softness: Slot, softness_gain: f32 },
    /// A Gaussian band around `centre`, width `width` — a stroke, an outline, or a specular streak,
    /// depending only on what the caller multiplies it by.
    Band { x: FieldRef, centre: Slot, centre_gain: f32, width: Slot },
    /// Fractal noise sampled at the pixel divided by `div` — grain, turbulence, procedural
    /// texture. Produces four decorrelated channels.
    Noise { div: Slot },
    /// A noise (or any multi-channel field) turned into a centred displacement vector:
    /// `(v.rg - 0.5) * gain`. What a warp consumes when the displacement is procedural rather than
    /// derived from a shape's geometry.
    Displacement { source: FieldRef, gain: Slot },
    /// The field's gradient — the true outward surface normal, by central difference of the source.
    /// The honest normal for any shape, including concave ones where a centre-radial guess points
    /// the wrong way.
    Gradient,
    /// A direction blended between a fixed tilt and a centre-radial estimate — the lens's historical
    /// stand-in for [`FieldOp::Gradient`]. Kept because it is what ships today; a concave source
    /// wants the gradient instead.
    RadialDirection { half: Slot2, splay: Slot, tilt: Slot },
    /// Snell refraction of a bevel: profile height and slope at `t` through an index of refraction,
    /// giving the displacement *distance* along the surface direction.
    Refract { t: FieldRef, thickness: Slot, ior: Slot, kind: Slot },
}

/// A field and the operators over it, in evaluation order, plus which nodes are its results.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldProgram {
    pub nodes: Vec<FieldOp>,
    /// The nodes the consumer reads, by name — codegen emits `let <name> = n<k>;`.
    pub outputs: Vec<(&'static str, FieldRef)>,
}

impl FieldProgram {
    /// The whole program: prologue, every node, then the named outputs. Emitted into a function
    /// that already has `gi: u32` (the field index), `fc: vec2<f32>` (the pixel) and a `fieldU`
    /// accessor in scope. Only the operator helpers a program actually uses are pulled in by
    /// [`Self::helpers`].
    #[must_use]
    pub fn wgsl(&self) -> String {
        format!("{}{}{}", self.wgsl_prologue(), self.wgsl_nodes(0..self.nodes.len()), self.wgsl_outputs())
    }

    /// `localPos`, the pixel relative to the source's centre — what the distance is measured from
    /// and what [`FieldRef::Local`] names. Empty for a program with no shape source at all: a purely
    /// procedural field (noise, a coordinate warp) has no centre to be relative to, which is the
    /// point of keeping the source separate from the operators.
    #[must_use]
    pub fn wgsl_prologue(&self) -> String {
        match self.source() {
            Some(_) => format!("    let localPos = fc - {};\n", self.centre_wgsl()),
            None => String::new(),
        }
    }

    /// A contiguous run of nodes, so a consumer can interleave its own code between them — a lens
    /// puts its outside-the-shape early-out straight after the distance, before anything else is
    /// evaluated.
    #[must_use]
    pub fn wgsl_nodes(&self, range: std::ops::Range<usize>) -> String {
        let mut out = String::new();
        for i in range {
            out.push_str(&format!("    let n{i} = {};\n", self.node_wgsl(&self.nodes[i])));
        }
        out
    }

    /// Whether the program declares an output by this name — how a consumer asks what a field
    /// actually produces instead of assuming a fixed tuple.
    #[must_use]
    pub fn declares(&self, name: &str) -> bool {
        self.outputs.iter().any(|(n, _)| *n == name)
    }

    /// The named output bindings.
    #[must_use]
    pub fn wgsl_outputs(&self) -> String {
        let mut out = String::new();
        for (name, r) in &self.outputs {
            out.push_str(&format!("    let {name} = {};\n", reference(*r)));
        }
        out
    }

    fn node_wgsl(&self, node: &FieldOp) -> String {
        match node {
            FieldOp::Distance(_) => "fieldDistance(gi, localPos)".to_string(),
            FieldOp::Ramp { d, edge, clamp_edge_to_extent } => {
                let e = if *clamp_edge_to_extent {
                    format!("min({e}, min({s}.x, {s}.y))", e = edge.wgsl(), s = self.extent_wgsl())
                } else {
                    edge.wgsl()
                };
                format!("fieldRamp({}, {e})", reference(*d))
            }
            FieldOp::Profile { t, kind } => {
                format!("fieldProfile({}, i32({}))", reference(*t), kind.wgsl())
            }
            FieldOp::ProfileSlope { t, kind } => {
                format!("fieldProfileSlope({}, i32({}))", reference(*t), kind.wgsl())
            }
            FieldOp::Coverage { d, softness, softness_gain } => format!(
                "fieldCoverage({}, {softness_gain:?} * {})",
                reference(*d),
                softness.wgsl()
            ),
            FieldOp::Band { x, centre, centre_gain, width } => format!(
                "fieldBand({}, {centre_gain:?} * {}, {})",
                reference(*x),
                centre.wgsl(),
                width.wgsl()
            ),
            FieldOp::Noise { div } => format!("fractalNoise(fc / max({}, 1.0))", div.wgsl()),
            FieldOp::Displacement { source, gain } => format!(
                "(({}.rg - vec2<f32>(0.5, 0.5)) * {})",
                reference(*source),
                gain.wgsl()
            ),
            FieldOp::Gradient => "fieldGradient(gi, fc)".to_string(),
            FieldOp::RadialDirection { half, splay, tilt } => format!(
                "fieldRadialDirection(localPos, {h}, {sp}, {ti})",
                h = half.wgsl(),
                sp = splay.wgsl(),
                ti = tilt.wgsl()
            ),
            FieldOp::Refract { t, thickness, ior, kind } => format!(
                "fieldRefract({}, {}, {}, i32({}))",
                reference(*t),
                thickness.wgsl(),
                ior.wgsl(),
                kind.wgsl()
            ),
        }
    }

    /// The shape this program measures distance from, if it has one.
    fn source(&self) -> Option<FieldSource> {
        self.nodes.iter().find_map(|n| match n {
            FieldOp::Distance(s) => Some(*s),
            _ => None,
        })
    }

    /// The source's half-extents. Only the operators that clamp to the shape ask for this, and they
    /// are meaningless without a shape.
    fn extent_wgsl(&self) -> String {
        let Some(src) = self.source() else {
            panic!("this operator needs a shape source; the program has none")
        };
        source_half(src).wgsl()
    }

    fn centre_wgsl(&self) -> String {
        let Some(src) = self.source() else {
            panic!("this operator needs a shape source; the program has none")
        };
        source_centre(src).wgsl()
    }

    /// The operator implementations this program needs, as WGSL. Emitting only what is used keeps a
    /// simple program (a mask, a stroke) from dragging in the bevel and refraction machinery.
    #[must_use]
    pub fn helpers(&self) -> String {
        let mut out = String::new();
        if let Some(src) = self.source() {
            out.push_str(&source_wgsl(src));
        }
        let uses = |f: &dyn Fn(&FieldOp) -> bool| self.nodes.iter().any(|n| f(n));
        if uses(&|n| matches!(n, FieldOp::Ramp { .. })) {
            out.push_str(FIELD_RAMP);
        }
        if uses(&|n| matches!(n, FieldOp::Profile { .. } | FieldOp::ProfileSlope { .. } | FieldOp::Refract { .. })) {
            out.push_str(FIELD_PROFILE);
        }
        if uses(&|n| matches!(n, FieldOp::Coverage { .. })) {
            out.push_str(FIELD_COVERAGE);
        }
        if uses(&|n| matches!(n, FieldOp::Band { .. })) {
            out.push_str(FIELD_BAND);
        }
        if uses(&|n| matches!(n, FieldOp::Noise { .. })) {
            out.push_str(FIELD_NOISE);
        }
        if uses(&|n| matches!(n, FieldOp::Gradient)) {
            // The gradient differentiates the source, so it needs the source as a function — which
            // is also the seam a baked provider would swap.
            let Some(src) = self.source() else {
                panic!("the gradient differentiates a source; the program has none")
            };
            out.push_str(&format!(
                "\nfn fieldDistanceAt(gi: u32, fc: vec2<f32>) -> f32 {{\n    return fieldDistance(gi, fc - {c});\n}}\n",
                c = source_centre(src).wgsl()
            ));
            out.push_str(FIELD_GRADIENT);
        }
        if uses(&|n| matches!(n, FieldOp::RadialDirection { .. })) {
            out.push_str(FIELD_RADIAL_DIRECTION);
        }
        if uses(&|n| matches!(n, FieldOp::Refract { .. })) {
            out.push_str(FIELD_REFRACT);
        }
        out
    }
}

/// The centre slot of any source — every source describes where its field is anchored, whatever it
/// measures distance to.
fn source_centre(src: FieldSource) -> Slot2 {
    match src {
        FieldSource::RoundedBox { centre, .. } | FieldSource::Sampled { centre, .. } => centre,
    }
}

/// The half-extent slot of any source.
fn source_half(src: FieldSource) -> Slot2 {
    match src {
        FieldSource::RoundedBox { half, .. } | FieldSource::Sampled { half, .. } => half,
    }
}

/// `fieldDistance`, the one accessor every distance operator goes through. Defining it per source is
/// the whole substitution: an analytic shape evaluates a formula, an arbitrary one reads its bake,
/// and no operator above this line knows which happened.
fn source_wgsl(src: FieldSource) -> String {
    match src {
        FieldSource::RoundedBox { half, corner, .. } => format!(
            "{SDF_ROUNDED_BOX}\nfn fieldDistance(gi: u32, p: vec2<f32>) -> f32 {{\n    return sdfRoundedBox(p, {h}, min({r}, min({h}.x, {h}.y)));\n}}\n",
            h = half.wgsl(),
            r = corner.wgsl()
        ),
        FieldSource::Sampled { half, decode, .. } => format!(
            "\nfn fieldDistance(gi: u32, p: vec2<f32>) -> f32 {{\n    let uv = p / (2.0 * {h}) + vec2<f32>(0.5, 0.5);\n    return (textureSampleLevel(fieldTex, samp, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r - 0.5) * {d};\n}}\n",
            h = half.wgsl(),
            d = decode.wgsl()
        ),
    }
}

fn reference(r: FieldRef) -> String {
    match r {
        FieldRef::Local => "localPos".to_string(),
        FieldRef::Node(i) => format!("n{i}"),
    }
}

/// The analytic rounded-box distance — the one place that knows what shape the field describes.
pub const SDF_ROUNDED_BOX: &str = r#"
fn sdfRoundedBox(p: vec2<f32>, halfSize: vec2<f32>, r: f32) -> f32 {
    let d = abs(p) - halfSize + vec2<f32>(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0))) - r;
}
"#;

/// Distance to a normalised inward edge parameter.
pub const FIELD_RAMP: &str = r#"
fn fieldRamp(d: f32, edge: f32) -> f32 {
    return clamp(-d / edge, 0.0, 1.0);
}
"#;

/// The bevel cross-section curves and their slope.
pub const FIELD_PROFILE: &str = r#"
fn fieldProfile(x: f32, kind: i32) -> f32 {
    let t = 1.0 - x;
    if (kind == 0) { return sqrt(max(0.0, 1.0 - t * t)); }
    let t4 = t * t * t * t;
    if (kind == 1) { return pow(max(0.0, 1.0 - t4), 0.25); }
    if (kind == 2) { return 1.0 - pow(max(0.0, 1.0 - t4), 0.25); }
    let c = pow(max(0.0, 1.0 - t4), 0.25);
    let sx = clamp(x, 0.0, 1.0);
    let ss = sx * sx * sx * (sx * (sx * 6.0 - 15.0) + 10.0);
    return mix(c, 1.0 - c, ss);
}
fn fieldProfileSlope(x: f32, kind: i32) -> f32 {
    let delta = 0.001;
    return (fieldProfile(min(1.0, x + delta), kind) - fieldProfile(max(0.0, x - delta), kind)) / (2.0 * delta);
}
"#;

/// Distance to antialiased coverage — a mask, in one line.
pub const FIELD_COVERAGE: &str = r#"
fn fieldCoverage(d: f32, softness: f32) -> f32 {
    return smoothstep(0.0, softness, -d);
}
"#;

/// A Gaussian band — a stroke, an outline, or a specular streak.
pub const FIELD_BAND: &str = r#"
fn fieldBand(x: f32, centre: f32, width: f32) -> f32 {
    return exp(-0.5 * pow((x - centre) / max(width, 1e-4), 2.0));
}
"#;

/// The field's true outward normal, by central difference of the source.
pub const FIELD_GRADIENT: &str = r#"
fn fieldGradient(gi: u32, fc: vec2<f32>) -> vec2<f32> {
    let e = vec2<f32>(0.5, 0.0);
    let g = vec2<f32>(
        fieldDistanceAt(gi, fc + e.xy) - fieldDistanceAt(gi, fc - e.xy),
        fieldDistanceAt(gi, fc + e.yx) - fieldDistanceAt(gi, fc - e.yx)
    );
    let l = length(g);
    if (l < 1e-6) { return vec2<f32>(0.0); }
    return g / l;
}
"#;


/// Fractal value noise: four decorrelated four-octave channels. Procedural like the distance
/// itself — no texture read, so it always fuses. The single implementation behind both the field
/// programs below and the standalone effect shaders in [`crate::vello::effects`], so the grain a
/// texture effect warps by and the grain a field program samples are the same noise.
pub const FIELD_NOISE: &str = r#"
fn _hash(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}
fn _vnoise(p: vec2<f32>, seed: f32) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let w = f * f * (3.0 - 2.0 * f);
    let s = vec2<f32>(seed, 0.0);
    let a = _hash(i + vec2<f32>(0.0, 0.0) + s);
    let b = _hash(i + vec2<f32>(1.0, 0.0) + s);
    let c = _hash(i + vec2<f32>(0.0, 1.0) + s);
    let d = _hash(i + vec2<f32>(1.0, 1.0) + s);
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
fn _fbm(p: vec2<f32>, seed: f32) -> f32 {
    var v = 0.0;
    var amp = 0.5;
    var freq = 1.0;
    for (var o = 0; o < 4; o = o + 1) {
        v = v + amp * _vnoise(p * freq, seed);
        freq = freq * 2.0;
        amp = amp * 0.5;
    }
    return v;
}
fn fractalNoise(p: vec2<f32>) -> vec4<f32> {
    return vec4<f32>(_fbm(p, 0.0), _fbm(p, 37.0), _fbm(p, 71.0), _fbm(p, 113.0));
}
"#;

/// The lens's historical direction estimate: a fixed tilt blended toward centre-radial.
pub const FIELD_RADIAL_DIRECTION: &str = r#"
fn fieldRadialDirection(localPos: vec2<f32>, halfSize: vec2<f32>, splay: f32, tilt: f32) -> vec2<f32> {
    let radialDir = normalize(localPos / max(vec2<f32>(1.0), halfSize));
    let flatDir = vec2<f32>(cos(tilt), sin(tilt));
    let blended = mix(flatDir, radialDir, splay);
    let l = length(blended);
    if (l > 0.001) { return blended / l; }
    return vec2<f32>(0.0);
}
"#;

/// Snell refraction through a bevel of the given profile.
pub const FIELD_REFRACT: &str = r#"
fn fieldSnell(theta1: f32, n1: f32, n2: f32) -> f32 {
    let s = (n1 / n2) * sin(theta1);
    if (abs(s) > 1.0) { return -1.0; }
    return asin(s);
}
fn fieldRefract(t: f32, thick: f32, n2: f32, kind: i32) -> f32 {
    if (t <= 0.0 || t >= 1.0) { return 0.0; }
    let h = fieldProfile(t, kind) * thick;
    let dh = fieldProfileSlope(t, kind) * thick;
    let sA = atan(dh);
    let tI = abs(sA);
    let tR = fieldSnell(tI, 1.0, n2);
    if (tR < 0.0) { return 0.0; }
    return (h * tan(tR) - h * tan(tI)) * sign(dh);
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn box_source() -> FieldSource {
        FieldSource::RoundedBox {
            centre: Slot2::new(0, 2),
            half: Slot2::new(1, 0),
            corner: Slot::new(1, 2),
        }
    }

    #[test]
    fn a_mask_is_a_two_node_program() {
        let p = FieldProgram {
            nodes: vec![
                FieldOp::Distance(box_source()),
                FieldOp::Coverage { d: FieldRef::Node(0), softness: Slot::new(4, 0), softness_gain: 1.5 },
            ],
            outputs: vec![("mask", FieldRef::Node(1))],
        };
        let src = p.wgsl();
        assert!(src.contains("fieldDistance(gi, localPos)"));
        assert!(src.contains("fieldCoverage"));
        assert!(src.contains("let mask = n1;"));
        // A mask must not drag in the bevel or refraction machinery.
        let h = p.helpers();
        assert!(h.contains("sdfRoundedBox"));
        assert!(h.contains("fn fieldCoverage"));
        assert!(!h.contains("fn fieldRefract"));
        assert!(!h.contains("fn fieldProfile"));
    }

    #[test]
    fn a_stroke_is_a_band_on_the_same_source() {
        let p = FieldProgram {
            nodes: vec![
                FieldOp::Distance(box_source()),
                FieldOp::Band {
                    x: FieldRef::Node(0),
                    centre: Slot::new(2, 0),
                    centre_gain: 1.0,
                    width: Slot::new(2, 1),
                },
            ],
            outputs: vec![("stroke", FieldRef::Node(1))],
        };
        assert!(p.helpers().contains("fn fieldBand"));
        assert!(p.wgsl().contains("let stroke = n1;"));
    }

    #[test]
    fn slots_address_the_consumers_uniform() {
        assert_eq!(Slot::new(3, 1).wgsl(), "fieldU(gi, 3u).y");
        assert_eq!(Slot2::new(0, 2).wgsl(), "fieldU(gi, 0u).zw");
    }
}

#[cfg(test)]
mod reuse_tests {
    use super::*;

    /// Wrap a program in the minimal shader its contract asks for — a `fieldU` accessor over a
    /// uniform, `gi` and `fc` in scope — so a program can be validated on its own.
    fn standalone(p: &FieldProgram, ret: &str) -> String {
        format!(
            "@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 6>;\n\
             fn fieldU(gi: u32, i: u32) -> vec4<f32> {{ return u[i]; }}\n\
             {helpers}\n\
             @fragment\n\
             fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {{\n\
             \x20   let gi = 0u;\n\
             \x20   let fc = pos.xy;\n\
             {body}\
             \x20   return {ret};\n\
             }}\n",
            helpers = p.helpers(),
            body = p.wgsl(),
        )
    }

    fn validate(src: &str) {
        let module = naga::front::wgsl::parse_str(src)
            .unwrap_or_else(|e| panic!("WGSL parse failed: {}\n{src}", e.emit_to_string(src)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("WGSL validation failed: {e:?}\n{src}"));
    }

    fn source() -> FieldSource {
        FieldSource::RoundedBox {
            centre: Slot2::new(0, 2),
            half: Slot2::new(1, 0),
            corner: Slot::new(1, 2),
        }
    }

    /// A mask: threshold the field. What every shape needs and what `Source::Coverage` rasterizes
    /// separately today.
    fn mask_program() -> FieldProgram {
        FieldProgram {
            nodes: vec![
                FieldOp::Distance(source()),
                FieldOp::Coverage { d: FieldRef::Node(0), softness: Slot::new(4, 0), softness_gain: 1.0 },
            ],
            outputs: vec![("mask", FieldRef::Node(1))],
        }
    }

    /// A stroke: a band around the zero level, no bevel machinery involved.
    fn stroke_program() -> FieldProgram {
        FieldProgram {
            nodes: vec![
                FieldOp::Distance(source()),
                FieldOp::Band {
                    x: FieldRef::Node(0),
                    centre: Slot::new(2, 0),
                    centre_gain: 1.0,
                    width: Slot::new(2, 1),
                },
            ],
            outputs: vec![("stroke", FieldRef::Node(1))],
        }
    }

    /// A bevel: the lens's shading machinery with the refraction removed, lit by the field's true
    /// gradient rather than the lens's centre-radial estimate.
    fn bevel_program() -> FieldProgram {
        FieldProgram {
            nodes: vec![
                FieldOp::Distance(source()),
                FieldOp::Ramp { d: FieldRef::Node(0), edge: Slot::new(2, 0), clamp_edge_to_extent: true },
                FieldOp::Profile { t: FieldRef::Node(1), kind: Slot::new(1, 3) },
                FieldOp::Gradient,
                FieldOp::Coverage { d: FieldRef::Node(0), softness: Slot::new(4, 0), softness_gain: 1.0 },
            ],
            outputs: vec![
                ("height", FieldRef::Node(2)),
                ("normal", FieldRef::Node(3)),
                ("mask", FieldRef::Node(4)),
            ],
        }
    }

    #[test]
    fn three_unrelated_effects_compile_from_one_operator_library() {
        validate(&standalone(&mask_program(), "vec4<f32>(mask)"));
        validate(&standalone(&stroke_program(), "vec4<f32>(stroke)"));
        validate(&standalone(&bevel_program(), "vec4<f32>(normal, height, mask)"));
    }

    #[test]
    fn the_lens_field_compiles_and_is_one_program_among_them() {
        let lens = crate::vello::glass::lens_field_program();
        validate(&standalone(&lens, "vec4<f32>(dir, refracted, mask)"));
        assert!(matches!(lens.nodes[0], FieldOp::Distance(FieldSource::RoundedBox { .. })));
    }

    /// Each program pays only for the operators it uses — a mask must not drag in refraction, and a
    /// stroke must not drag in the bevel curves.
    #[test]
    fn helper_emission_is_per_program() {
        let mask = mask_program().helpers();
        assert!(mask.contains("fn fieldCoverage") && !mask.contains("fn fieldRefract") && !mask.contains("fn fieldProfile"));
        let stroke = stroke_program().helpers();
        assert!(stroke.contains("fn fieldBand") && !stroke.contains("fn fieldRefract"));
        let lens = crate::vello::glass::lens_field_program().helpers();
        assert!(lens.contains("fn fieldRefract") && lens.contains("fn fieldRamp"));
        assert!(!lens.contains("fn fieldGradient"), "the lens still uses the radial estimate");
    }

    /// The texture effect's displacement — noise, centred and scaled — is a two-node field program.
    /// It is the same chain `TEXTURE_WGSL` fuses by hand, which is what would let that effect stop
    /// being an opaque custom shader and start fusing and batching with its neighbours.
    #[test]
    fn a_procedural_displacement_is_two_nodes() {
        let p = FieldProgram {
            nodes: vec![
                FieldOp::Noise { div: Slot::new(0, 3) },
                FieldOp::Displacement { source: FieldRef::Node(0), gain: Slot::new(0, 2) },
            ],
            outputs: vec![("disp", FieldRef::Node(1))],
        };
        let src = p.wgsl();
        assert!(src.contains("fractalNoise(fc / max(fieldU(gi, 0u).w, 1.0))"));
        assert!(src.contains("- vec2<f32>(0.5, 0.5)"));
        let h = p.helpers();
        assert!(h.contains("fn _fbm") && h.contains("fn fractalNoise"));
        // Noise is procedural: it must not drag in any shape machinery.
        assert!(!h.contains("fn fieldRefract") && !h.contains("fn fieldRamp"));
    }

    /// A procedural displacement must be able to produce a `computeField` of its own — no shape, no
    /// bezel, no specular. Until the tail followed the program's declared outputs this was
    /// impossible: every generated field ended in the lens's assembly, so the texture effect had
    /// nowhere to lower to and stayed an opaque shader.
    #[test]
    fn a_shapeless_field_still_generates_a_compute_field() {
        let p = FieldProgram {
            nodes: vec![
                FieldOp::Noise { div: Slot::new(0, 3) },
                FieldOp::Displacement { source: FieldRef::Node(0), gain: Slot::new(0, 2) },
            ],
            outputs: vec![("displacement", FieldRef::Node(1))],
        };
        let src = format!(
            "@group(0) @binding(0) var<uniform> u: array<vec4<f32>, 6>;\n\
             fn fieldU(gi: u32, i: u32) -> vec4<f32> {{ return u[i]; }}\n\
             {prelude}\n\
             @fragment\n\
             fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {{\n\
             \x20   return computeField(0u, pos.xy);\n\
             }}\n",
            prelude = crate::vello::glass::field_prelude(&p),
        );
        validate(&src);
        // No shape, so none of the lens machinery may appear.
        assert!(!src.contains("glassSpecular(edgeT"), "no lens assembly");
        assert!(!src.contains("let localPos"), "no centre to be relative to");
        assert!(src.contains("return vec4<f32>(displacement.x, displacement.y, 0.0, 1.0);"));
    }

    /// One noise implementation, shared: the effect shaders and the field programs must not drift.
    #[test]
    fn the_effect_shaders_and_field_programs_share_one_noise() {
        assert_eq!(crate::vello::effects::fractal_noise_wgsl(), FIELD_NOISE);
    }

    /// The gradient differentiates whatever source the program declares, so swapping the source is
    /// the single edit an arbitrary-geometry provider needs.
    #[test]
    fn the_gradient_follows_the_declared_source() {
        let h = bevel_program().helpers();
        assert!(h.contains("fn fieldDistanceAt"));
        assert!(h.contains("return fieldDistance(gi, fc - fieldU(gi, 0u).zw"));
        assert!(h.contains("sdfRoundedBox(p,"));
    }

    fn box_source() -> FieldSource {
        let FieldOp::Distance(s) = bevel_program().nodes[0] else {
            panic!("the bevel starts from a distance")
        };
        s
    }

    fn sampled_source() -> FieldSource {
        FieldSource::Sampled {
            centre: Slot2::new(0, 2),
            half: Slot2::new(1, 0),
            decode: Slot::new(1, 2),
        }
    }

    /// The two sources stay two code paths, and each pays only its own cost: an analytic shape
    /// evaluates a formula and never touches a texture, an arbitrary one reads its bake and never
    /// carries the box algebra. Everything above `fieldDistance` is written once for both.
    #[test]
    fn the_analytic_and_sampled_sources_are_separate_paths() {
        let mask = |src| FieldProgram {
            nodes: vec![
                FieldOp::Distance(src),
                FieldOp::Coverage { d: FieldRef::Node(0), softness: Slot::new(4, 0), softness_gain: 1.5 },
            ],
            outputs: vec![("mask", FieldRef::Node(1))],
        };

        let analytic = mask(box_source()).helpers();
        assert!(analytic.contains("sdfRoundedBox(p,"));
        assert!(!analytic.contains("textureSampleLevel"));

        let sampled = mask(sampled_source()).helpers();
        assert!(sampled.contains("textureSampleLevel(fieldTex"));
        assert!(!sampled.contains("sdfRoundedBox"));

        // ...and the operators above them are the same text either way.
        assert_eq!(mask(box_source()).wgsl(), mask(sampled_source()).wgsl());
    }

    /// The whole point of the substitution: an effect written for analytic shapes compiles for an
    /// arbitrary one with no change to the effect. Bevel is the hardest case — it differentiates the
    /// field, so it reaches the source twice.
    #[test]
    fn a_bevel_compiles_on_a_sampled_source() {
        let mut p = bevel_program();
        let FieldOp::Distance(_) = p.nodes[0] else { panic!("bevel starts from a distance") };
        p.nodes[0] = FieldOp::Distance(sampled_source());
        let h = p.helpers();
        assert!(h.contains("fn fieldDistanceAt"));
        assert!(h.contains("textureSampleLevel(fieldTex"));
        assert!(!h.contains("sdfRoundedBox"));
        assert!(h.contains("fn fieldGradient"));
    }
}
