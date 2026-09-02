//! Field programs as generated data: `fine.wgsl`'s field section, emitted from the same
//! [`crate::field::FieldProgram`] definitions the über path compiles.
//!
//! `fine`'s per-pixel field math — the lens refraction, the noise displacement, the radial falloff —
//! used to be hand-written switch arms that duplicated the field.rs codegen the per-effect pipelines
//! already run, and each hand-written arm kept its anchor in a different uniform slot, which forced
//! a per-program `match desc[1]` shim into the mark emitter. This module is the single generator for
//! both facts:
//!
//! - [`fine_field_wgsl`] emits the whole section — the operator library, one `fx_computeField_<name>`
//!   arm per registered program, and the `fx_computeField` dispatcher — through a *dialect transform*
//!   over the exact field.rs/units.rs texts the über path uses. `fine`'s build cannot splice host
//!   strings in, so the output is CHECKED IN between markers and locked by
//!   [`tests::fine_carries_the_generated_field_section`]; edit the programs, then re-bless with
//!   `WV_BLESS_FINE_FIELD=1 cargo test -p render_core --lib vello::fine_field`.
//! - [`programs`] is the registry `d.program` indexes — id, name, program, and the anchor slot the
//!   emitter stamps into operand record 3 ([`crate::vello::bake::stamp_field_anchor`]), so adding a
//!   field means adding a table entry, never a shader arm or an emitter branch.
//!
//! The dialect differences from the über emission are mechanical and total: `fieldU(gi, n)` becomes
//! `u[n]` (the descriptor's six vec4s arrive as a value, not a binding), operator helpers take the
//! `fx_` prefix `fine` namespaces its effect code under, each program's `fieldDistance` is suffixed
//! with the program name (they coexist in one shader), and every program is evaluated in
//! anchor-relative coordinates — `fine` runs in device space, so the anchor from record 3 supplies
//! the frame a per-effect pipeline gets from its cell. The distance override for a baked outline
//! (record 3 source = input register) is likewise one shared function over `input_in`, not a
//! per-program fact.

use crate::field::{FieldOp, FieldProgram, FieldSource, Slot2};

/// One registered field program: what `d.program == id` dispatches to, and where its anchor lives.
pub(crate) struct FineProgram {
    pub id: u32,
    /// Suffix of the generated `fx_computeField_<name>` / `fx_fieldDistance_<name>` functions.
    pub name: &'static str,
    /// The `// …` line above the generated arm.
    pub doc: &'static str,
    pub program: FieldProgram,
    /// The uniform slot holding the field's coordinate anchor — the source's centre for a shaped
    /// program, declared explicitly for a shapeless one (noise anchors its grain to the shape).
    pub anchor: Option<Slot2>,
}

/// The program registry, in dispatch order. Ids are the [`crate::vello::bake`] `PROGRAM_*` tags.
pub(crate) fn programs() -> Vec<FineProgram> {
    let lens = super::units::lens_field_program();
    let texture = crate::effect_graph::texture_field_program();
    let radial = crate::effect_graph::radial_field_program();
    vec![
        FineProgram {
            id: crate::vello::bake::PROGRAM_ROUNDED_BOX as u32,
            name: "lens",
            doc: "The analytic lens field at a device pixel centre: (displacement.xy, specular, mask),\n// assembled from the ramp/refraction/coverage operators over the rounded-box distance.",
            anchor: lens.anchor(),
            program: lens,
        },
        FineProgram {
            id: crate::vello::bake::PROGRAM_NOISE as u32,
            name: "texture",
            doc: "The fractal-noise displacement field, evaluated in the frame the field record anchors\n// (the grain rides the shape). Magnitude `u[0].z`, grain `u[0].w`.",
            anchor: Some(Slot2::new(2, 0)),
            program: texture,
        },
        FineProgram {
            id: crate::vello::bake::PROGRAM_RADIAL as u32,
            name: "radial",
            doc: "The radial ramp field: mask and specular fall linearly from 1 at the centre to 0 at\n// radius `u[1].x` — the background field-tint's gradient.",
            anchor: radial.anchor(),
            program: radial,
        },
    ]
}

/// The über→fine dialect transform: uniform access by value, `fx_`-prefixed helper names.
fn dialect(s: &str) -> String {
    let mut out = s.to_owned();
    for n in 0..6 {
        out = out.replace(&format!("fieldU(gi, {n}u)"), &format!("u[{n}]"));
    }
    const RENAMES: &[(&str, &str)] = &[
        ("fieldProfileSlope", "fx_profileSlope"),
        ("fieldProfile", "fx_profile"),
        ("fieldRadialDirection", "fx_radialDirection"),
        ("fieldRamp", "fx_ramp"),
        ("fieldCoverage", "fx_coverage"),
        ("fieldBand", "fx_band"),
        ("fieldRefract", "fx_refract"),
        ("fieldSnell", "fx_snell"),
        ("sdfRoundedBox", "fx_sdfRoundedBox"),
        ("unitSpecular", "fx_specular"),
    ];
    for (from, to) in RENAMES {
        out = out.replace(from, to);
    }
    out
}

/// The operator library the registered programs need, deduplicated across programs — the same
/// per-use emission rule as [`FieldProgram::helpers`], over the union.
fn helper_library(ps: &[FineProgram]) -> String {
    let any = |f: &dyn Fn(&FieldOp) -> bool| ps.iter().any(|e| e.program.nodes.iter().any(f));
    let lensish = ps.iter().any(|e| e.program.declares("refracted"));
    let mut out = String::new();
    if any(&|n| matches!(n, FieldOp::Distance(FieldSource::RoundedBox { .. }))) {
        out.push_str(crate::field::SDF_ROUNDED_BOX);
    }
    if any(&|n| matches!(n, FieldOp::Ramp { .. })) {
        out.push_str(crate::field::FIELD_RAMP);
    }
    if any(&|n| {
        matches!(n, FieldOp::Profile { .. } | FieldOp::ProfileSlope { .. } | FieldOp::Refract { .. })
    }) {
        out.push_str(crate::field::FIELD_PROFILE);
    }
    if any(&|n| matches!(n, FieldOp::Coverage { .. })) {
        out.push_str(crate::field::FIELD_COVERAGE);
    }
    if any(&|n| matches!(n, FieldOp::RadialDirection { .. })) {
        out.push_str(crate::field::FIELD_RADIAL_DIRECTION);
    }
    if any(&|n| matches!(n, FieldOp::Refract { .. })) {
        out.push_str(crate::field::FIELD_REFRACT);
    }
    if any(&|n| matches!(n, FieldOp::Band { .. })) || lensish {
        out.push_str(crate::field::FIELD_BAND);
    }
    if lensish {
        out.push_str(super::units::UNIT_SPECULAR);
    }
    if any(&|n| matches!(n, FieldOp::Noise { .. })) {
        out.push_str(crate::field::FIELD_NOISE);
    }
    dialect(&out)
}

/// The shape-following distance override, shared by every shaped program: a baked signed-distance
/// field of the real outline, read from `input_in` at device pixels with a manual bilinear filter.
/// The texel stores `0.5 + d / decode`. This is `fine`'s [`FieldSource::Sampled`] — record 3 names
/// the input register as the distance source, so it is one function, never a per-program fact.
const SAMPLED_DISTANCE: &str = r#"#ifdef have_input
fn fx_fieldDistance_sampled(fc: vec2<f32>, decode: f32) -> f32 {
    let fp = fc - vec2<f32>(0.5, 0.5);
    let fl = floor(fp);
    let i0 = vec2<i32>(i32(fl.x), i32(fl.y));
    let f = fp - fl;
    let s00 = textureLoad(input_in, i0, 0).r;
    let s10 = textureLoad(input_in, i0 + vec2<i32>(1, 0), 0).r;
    let s01 = textureLoad(input_in, i0 + vec2<i32>(0, 1), 0).r;
    let s11 = textureLoad(input_in, i0 + vec2<i32>(1, 1), 0).r;
    let texel = mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
    return (texel - 0.5) * decode;
}
#endif
"#;

/// One program's arm: its distance function (if it declares a source), then
/// `fx_computeField_<name>` — prologue, sampled override, early-out, the program's nodes and
/// outputs, and the same tail [`super::units::field_prelude`] gives the über emission.
fn program_arm(e: &FineProgram) -> String {
    let p = &e.program;
    let shaped = p.source().is_some();
    let mut body = String::from("    let scale = u[4].x;\n    let localPos = fc - anchor;\n");
    let nodes = if shaped {
        body.push_str(&format!("    var n0 = fx_fieldDistance_{}(u, localPos);\n", e.name));
        body.push_str(
            "#ifdef have_input\n    if (sampled) {\n        n0 = fx_fieldDistance_sampled(fc, decode);\n    }\n#endif\n",
        );
        if p.declares("dist") {
            body.push_str("    if (n0 > 0.0) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }\n");
        }
        p.wgsl_nodes(1..p.nodes.len())
    } else {
        p.wgsl_nodes(0..p.nodes.len())
    };
    body.push_str(&dialect(&nodes).replace("(fc ", "(localPos "));
    body.push_str(&dialect(&p.wgsl_outputs()));
    body.push_str(&if p.declares("refracted") {
        dialect(super::units::LENS_ASSEMBLY)
    } else {
        super::units::generic_field_pack(p)
    });
    let dist = p.source().map_or_else(String::new, |src| {
        dialect(&crate::field::source_distance_fn(src).replace(
            "fn fieldDistance(gi: u32, ",
            &format!("fn fx_fieldDistance_{}(u: array<vec4<f32>, 6>, ", e.name),
        ))
    });
    format!(
        "{dist}// {doc}\nfn fx_computeField_{name}(u: array<vec4<f32>, 6>, fc: vec2<f32>, anchor: vec2<f32>, sampled: bool, decode: f32) -> vec4<f32> {{\n{body}}}\n",
        doc = e.doc,
        name = e.name,
    )
}

fn dispatcher(ps: &[FineProgram]) -> String {
    let mut out = String::from(
        "// Field program dispatch over the math tag (slot 1); anything else measures no field. The\n\
         // field's distance SOURCE and coordinate anchor come from operand record 3, never from the\n\
         // program.\n\
         fn fx_computeField(d: FxDesc, fc: vec2<f32>) -> vec4<f32> {\n\
         \x20   let anchor = d.rec[3].yz;\n\
         \x20   let sampled = d.rec[3].x == 2.0;\n",
    );
    for e in ps {
        out.push_str(&format!(
            "    if (d.program == {}u) {{ return fx_computeField_{}(d.u, fc, anchor, sampled, d.rec[3].w); }}\n",
            e.id, e.name
        ));
    }
    out.push_str("    return vec4<f32>(0.0, 0.0, 0.0, 1.0);\n}\n");
    out
}

/// The whole generated section, in declaration order: operator library, the sampled-distance
/// override, one arm per program, the dispatcher.
#[must_use]
pub fn fine_field_wgsl() -> String {
    let ps = programs();
    let mut out = String::from(
        "// Generated by render_core::vello::fine_field — the operator library and every program\n\
         // below are data (field.rs / units.rs / effect_graph.rs). Edit those, then re-bless with\n\
         // `WV_BLESS_FINE_FIELD=1 cargo test -p render_core --lib vello::fine_field`; never edit here.\n",
    );
    out.push_str(&helper_library(&ps));
    out.push_str(SAMPLED_DISTANCE);
    for e in &ps {
        out.push_str(&program_arm(e));
    }
    out.push_str(&dispatcher(&ps));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FINE: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../vello/vello_shaders/shader/fine.wgsl");
    const BEGIN: &str = "// ==== BEGIN GENERATED: field programs ====\n";
    const END: &str = "// ==== END GENERATED: field programs ====";

    /// `fine.wgsl` carries [`fine_field_wgsl`]'s output verbatim between the markers. Its build
    /// cannot splice host strings in, so the section is checked in; this test is what makes it
    /// generated DATA rather than a copy — any drift from the field.rs/units.rs sources fails here.
    /// Re-bless after editing a program: `WV_BLESS_FINE_FIELD=1 cargo test -p render_core --lib
    /// vello::fine_field`.
    #[test]
    fn fine_carries_the_generated_field_section() {
        let fine = std::fs::read_to_string(FINE).expect("fine.wgsl readable from the core crate");
        let begin = fine.find(BEGIN).expect("fine.wgsl has the BEGIN marker") + BEGIN.len();
        let end = fine.find(END).expect("fine.wgsl has the END marker");
        assert!(begin <= end, "markers out of order");
        let generated = fine_field_wgsl();
        if std::env::var_os("WV_BLESS_FINE_FIELD").is_some() {
            let blessed = format!("{}{}{}", &fine[..begin], generated, &fine[end..]);
            std::fs::write(FINE, blessed).expect("fine.wgsl writable");
            return;
        }
        assert!(
            fine[begin..end] == generated,
            "fine.wgsl's field section drifted from the generator — run \
             WV_BLESS_FINE_FIELD=1 cargo test -p render_core --lib vello::fine_field"
        );
    }

    /// Every generated arm validates as WGSL on its own (the `have_input` permutation adds only the
    /// sampled override, exercised by the executor build).
    #[test]
    fn the_generated_section_is_valid_wgsl() {
        let body: String = fine_field_wgsl()
            .lines()
            .scan(false, |skipping, l| {
                let take = !*skipping && !l.starts_with("#ifdef");
                if l.starts_with("#ifdef") {
                    *skipping = true;
                }
                if l.starts_with("#endif") {
                    *skipping = false;
                }
                Some(take.then(|| format!("{l}\n")))
            })
            .flatten()
            .collect();
        let src = format!(
            "struct FxDesc {{\n    bits: u32,\n    program: u32,\n    u: array<vec4<f32>, 6>,\n    rec: array<vec4<f32>, 5>,\n}}\n{body}\n@fragment\nfn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {{\n    var d: FxDesc;\n    return fx_computeField(d, pos.xy);\n}}\n"
        );
        let module = naga::front::wgsl::parse_str(&src)
            .unwrap_or_else(|e| panic!("WGSL parse failed: {}\n{src}", e.emit_to_string(&src)));
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&module)
        .unwrap_or_else(|e| panic!("WGSL validation failed: {e:?}\n{src}"));
    }

    /// The registry's anchor slots are the exact descriptor indices the retired emitter shim
    /// hard-coded per program: lens/radial centre at `u[0].zw` (desc 4..6), noise origin at
    /// `u[2].xy` (desc 10..12).
    #[test]
    fn anchors_land_where_the_shim_put_them() {
        let flat = |e: &FineProgram| {
            e.anchor.map(|s| 2 + 4 * usize::from(s.vec4) + usize::from(s.comp))
        };
        let ps = programs();
        let by_id = |id: u32| ps.iter().find(|e| e.id == id).expect("registered");
        assert_eq!(flat(by_id(1)), Some(4));
        assert_eq!(flat(by_id(2)), Some(10));
        assert_eq!(flat(by_id(3)), Some(4));
    }
}
