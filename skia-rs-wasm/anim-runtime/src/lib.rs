//! anim-runtime — the portable animation runtime core, a Rust port of the
//! TypeScript `anim/` IR (see skia-rs-wasm/src/lib/renderer/anim). It mirrors
//! `types.ts` (the IR + serde-mapped to the exact JSON contract), `sample.ts`
//! (the curve atom), `evaluate.ts` (the timeline evaluator), and `serialize.ts`
//! (the versioned format envelope).
//!
//! This is the piece that ships to every platform. The TS tests are the
//! behavior spec; the tests below mirror them, and `deserializes_the_ts_contract`
//! proves cross-language parity by parsing the exact bytes the TS serializer
//! emits and evaluating them to the same values.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod session;

// ---------- IR (mirrors anim/types.ts) ----------

/// Interpolation into the next key: a named preset, or explicit cubic-bezier
/// control points `[x1, y1, x2, y2]`. `hold` is a step. Untagged: a JSON string
/// is a preset, a 4-array is explicit control points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Interp {
    Named(String),
    Cubic([f64; 4]),
}

/// One sample point on a curve: a scalar `value` at domain position `at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Key {
    pub at: f64,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interp: Option<Interp>,
}

/// The domain a curve is sampled over — time (a keyframe track) or a named param.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Domain {
    Time,
    Param { param: String },
}

/// A scalar function of its domain, defined by keys ascending in `at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Curve {
    pub domain: Domain,
    pub keys: Vec<Key>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamKind {
    Number,
    Bool,
    Trigger,
}

/// A named input / parameter that feeds param-domain curves.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Param {
    pub id: String,
    pub kind: ParamKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

/// Which object a binding drives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ObjectRef {
    Node { id: String },
    Bone { id: String },
    Param { id: String },
}

impl ObjectRef {
    pub fn id(&self) -> &str {
        match self {
            ObjectRef::Node { id } | ObjectRef::Bone { id } | ObjectRef::Param { id } => id,
        }
    }
    pub fn is_node(&self) -> bool {
        matches!(self, ObjectRef::Node { .. })
    }
}

/// A concrete animatable target: an object plus a property path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub object: ObjectRef,
    pub prop: String,
}

/// The atom of animation: a property driven by a curve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub target: Target,
    pub curve: Curve,
}

/// A named animation: bindings evaluated together over one clock.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Timeline {
    pub id: String,
    pub duration: f64,
    #[serde(rename = "loop", default, skip_serializing_if = "Option::is_none")]
    pub looping: Option<bool>,
    pub bindings: Vec<Binding>,
}

/// The runtime document — params + timelines. Authoring metadata is excluded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnimDoc {
    pub params: Vec<Param>,
    pub timelines: Vec<Timeline>,
}

/// What a curve is sampled against: the current time (ms) and live param values.
#[derive(Debug, Clone, Default)]
pub struct EvalContext {
    pub time: f64,
    pub params: HashMap<String, f64>,
}

// ---------- Sampler (mirrors anim/sample.ts) ----------

fn bezier1(t: f64, p1: f64, p2: f64) -> f64 {
    let u = 1.0 - t;
    3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t
}

/// A cubic-bezier easing as a progress remap `u -> eased(u)` (Newton + bisection),
/// matching sample.ts. The linear identity is handled fast.
fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, u: f64) -> f64 {
    if x1 == 0.0 && y1 == 0.0 && x2 == 1.0 && y2 == 1.0 {
        return u;
    }
    let x = u.clamp(0.0, 1.0);
    let mut t = x;
    for _ in 0..8 {
        let dx = bezier1(t, x1, x2) - x;
        if dx.abs() < 1e-6 {
            break;
        }
        let d = 3.0 * (1.0 - t) * (1.0 - t) * x1 + 6.0 * (1.0 - t) * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2);
        if d.abs() < 1e-6 {
            break;
        }
        t -= dx / d;
    }
    if !(0.0..=1.0).contains(&t) {
        let (mut lo, mut hi) = (0.0, 1.0);
        t = x;
        for _ in 0..20 {
            t = (lo + hi) / 2.0;
            let bx = bezier1(t, x1, x2);
            if (bx - x).abs() < 1e-6 {
                break;
            }
            if bx < x {
                lo = t;
            } else {
                hi = t;
            }
        }
    }
    bezier1(t, y1, y2)
}

/// Turn an interp into an eased progress at `u`. `hold` steps; the caller keeps
/// the start value until the next key.
fn eased(interp: &Option<Interp>, u: f64) -> f64 {
    match interp {
        None => u,
        Some(Interp::Cubic(c)) => cubic_bezier(c[0], c[1], c[2], c[3], u),
        Some(Interp::Named(name)) => match name.as_str() {
            "linear" => u,
            "hold" => 0.0,
            "easeIn" => cubic_bezier(0.42, 0.0, 1.0, 1.0, u),
            "easeOut" => cubic_bezier(0.0, 0.0, 0.58, 1.0, u),
            "easeInOut" => cubic_bezier(0.42, 0.0, 0.58, 1.0, u),
            _ => u,
        },
    }
}

/// Sample a curve at domain position `x`. Clamps to the first/last key outside
/// the keyed range; `None` for an empty curve.
pub fn sample_curve(curve: &Curve, x: f64) -> Option<f64> {
    let ks = &curve.keys;
    if ks.is_empty() {
        return None;
    }
    if ks.len() == 1 {
        return Some(ks[0].value);
    }
    if x <= ks[0].at {
        return Some(ks[0].value);
    }
    let last = &ks[ks.len() - 1];
    if x >= last.at {
        return Some(last.value);
    }
    let mut i = 0;
    while i < ks.len() - 1 && ks[i + 1].at <= x {
        i += 1;
    }
    let k0 = &ks[i];
    let k1 = &ks[i + 1];
    let span = k1.at - k0.at;
    let u = if span <= 0.0 { 0.0 } else { (x - k0.at) / span };
    let e = eased(&k0.interp, u);
    Some(k0.value + (k1.value - k0.value) * e)
}

/// Resolve a domain to its current independent-variable value.
pub fn domain_value_at(domain: &Domain, time: f64, params: &HashMap<String, f64>) -> f64 {
    match domain {
        Domain::Time => time,
        Domain::Param { param } => *params.get(param).unwrap_or(&0.0),
    }
}

pub fn domain_value(domain: &Domain, ctx: &EvalContext) -> f64 {
    domain_value_at(domain, ctx.time, &ctx.params)
}

/// Evaluate a binding: its target property and sampled value, or `None` if empty.
pub fn sample_binding_at<'a>(b: &'a Binding, time: f64, params: &HashMap<String, f64>) -> Option<(&'a Target, f64)> {
    sample_curve(&b.curve, domain_value_at(&b.curve.domain, time, params)).map(|v| (&b.target, v))
}

pub fn sample_binding<'a>(b: &'a Binding, ctx: &EvalContext) -> Option<(&'a Target, f64)> {
    sample_binding_at(b, ctx.time, &ctx.params)
}

// ---------- Evaluator (mirrors anim/evaluate.ts) ----------

/// Map a master time onto the timeline range: wrap when looping, clamp otherwise.
pub fn normalize_time(t: f64, duration: f64, looping: bool) -> f64 {
    if duration <= 0.0 {
        0.0
    } else if looping {
        let m = t % duration;
        if m < 0.0 {
            m + duration
        } else {
            m
        }
    } else {
        t.clamp(0.0, duration)
    }
}

/// A node's sampled properties this frame.
pub type PropertyBag = HashMap<String, f64>;

/// Evaluate a timeline to per-node property bags. Time is normalized to the
/// timeline's range first (loop/clamp); params pass through. Non-node targets are
/// skipped (their evaluators land in later slices).
pub fn evaluate_timeline(tl: &Timeline, ctx: &EvalContext) -> HashMap<String, PropertyBag> {
    let nt = normalize_time(ctx.time, tl.duration, tl.looping.unwrap_or(false));
    let mut out: HashMap<String, PropertyBag> = HashMap::new();
    for b in &tl.bindings {
        if let Some((target, value)) = sample_binding_at(b, nt, &ctx.params) {
            if !target.object.is_node() {
                continue;
            }
            out.entry(target.object.id().to_string())
                .or_default()
                .insert(target.prop.clone(), value);
        }
    }
    out
}

// ---------- Serialization (mirrors anim/serialize.ts) ----------

/// v0 = the simple tier (drivers on the scene graph). Bump on incompatible change.
pub const ANIM_FORMAT_VERSION: u32 = 0;

#[derive(Debug, Deserialize)]
struct AnimFileOwned {
    version: u32,
    doc: AnimDoc,
}

#[derive(Serialize)]
struct AnimFileRef<'a> {
    version: u32,
    doc: &'a AnimDoc,
}

/// Thrown when a document fails to parse or validate.
#[derive(Debug)]
pub struct FormatError(pub String);

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for FormatError {}

/// Serialize a runtime doc to the versioned JSON contract (matches serialize.ts).
pub fn serialize_anim_doc(doc: &AnimDoc) -> String {
    serde_json::to_string(&AnimFileRef {
        version: ANIM_FORMAT_VERSION,
        doc,
    })
    .expect("AnimDoc is always serializable")
}

/// Parse + validate the versioned contract. serde's typed deserialize IS the
/// structural validation (a bad key/domain fails to parse); we add the version gate.
pub fn deserialize_anim_doc(json: &str) -> Result<AnimDoc, FormatError> {
    let file: AnimFileOwned = serde_json::from_str(json).map_err(|e| FormatError(format!("malformed doc: {e}")))?;
    if file.version != ANIM_FORMAT_VERSION {
        return Err(FormatError(format!(
            "unsupported format version {} (expected {})",
            file.version, ANIM_FORMAT_VERSION
        )));
    }
    Ok(file.doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(time: f64, params: &[(&str, f64)]) -> EvalContext {
        EvalContext {
            time,
            params: params.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
        }
    }

    fn time_curve(keys: Vec<Key>) -> Curve {
        Curve {
            domain: Domain::Time,
            keys,
        }
    }

    fn k(at: f64, value: f64) -> Key {
        Key { at, value, interp: None }
    }

    // --- sample_curve (mirrors sample.test.ts) ---
    #[test]
    fn sample_curve_empty_and_single() {
        assert_eq!(sample_curve(&time_curve(vec![]), 100.0), None);
        assert_eq!(sample_curve(&time_curve(vec![k(0.0, 42.0)]), 999.0), Some(42.0));
    }

    #[test]
    fn sample_curve_clamps_and_lerps() {
        let c = time_curve(vec![k(100.0, 10.0), k(300.0, 30.0)]);
        assert_eq!(sample_curve(&c, 0.0), Some(10.0));
        assert_eq!(sample_curve(&c, 500.0), Some(30.0));
        let c2 = time_curve(vec![k(0.0, 0.0), k(200.0, 100.0)]);
        assert!((sample_curve(&c2, 100.0).unwrap() - 50.0).abs() < 1e-6);
    }

    #[test]
    fn sample_curve_multi_segment_and_hold() {
        let c = time_curve(vec![k(0.0, 0.0), k(100.0, 100.0), k(200.0, 0.0)]);
        assert!((sample_curve(&c, 150.0).unwrap() - 50.0).abs() < 1e-6);
        let held = time_curve(vec![
            Key { at: 0.0, value: 0.0, interp: Some(Interp::Named("hold".into())) },
            k(100.0, 100.0),
        ]);
        assert_eq!(sample_curve(&held, 50.0), Some(0.0));
        assert_eq!(sample_curve(&held, 100.0), Some(100.0));
    }

    #[test]
    fn eased_curves_bend_the_middle() {
        // linear identity
        assert!((eased(&None, 0.5) - 0.5).abs() < 1e-6);
        // easeOut is ahead of linear at the midpoint (mirrors resolveInterp test)
        assert!(eased(&Some(Interp::Named("easeOut".into())), 0.5) > 0.5);
        // explicit easeInOut is symmetric about 0.5
        assert!((eased(&Some(Interp::Cubic([0.42, 0.0, 0.58, 1.0])), 0.5) - 0.5).abs() < 1e-2);
    }

    // --- domain / binding ---
    #[test]
    fn domain_and_binding() {
        assert_eq!(domain_value_at(&Domain::Time, 250.0, &HashMap::new()), 250.0);
        let params: HashMap<String, f64> = [("speed".to_string(), 0.7)].into_iter().collect();
        assert_eq!(domain_value_at(&Domain::Param { param: "speed".into() }, 0.0, &params), 0.7);
        assert_eq!(domain_value_at(&Domain::Param { param: "missing".into() }, 0.0, &params), 0.0);

        let target = Target { object: ObjectRef::Node { id: "n1".into() }, prop: "x".into() };
        let time_b = Binding { target: target.clone(), curve: time_curve(vec![k(0.0, 0.0), k(100.0, 300.0)]) };
        assert_eq!(sample_binding(&time_b, &ctx(50.0, &[])).map(|(_, v)| v), Some(150.0));

        let param_b = Binding {
            target,
            curve: Curve { domain: Domain::Param { param: "yaw".into() }, keys: vec![k(-1.0, -30.0), k(1.0, 30.0)] },
        };
        assert_eq!(sample_binding(&param_b, &ctx(999.0, &[("yaw", 0.0)])).map(|(_, v)| v), Some(0.0));
        assert_eq!(sample_binding(&param_b, &ctx(0.0, &[("yaw", 1.0)])).map(|(_, v)| v), Some(30.0));
    }

    // --- normalize_time (mirrors evaluate.test.ts) ---
    #[test]
    fn normalize_clamp_wrap_zero() {
        assert_eq!(normalize_time(-50.0, 1000.0, false), 0.0);
        assert_eq!(normalize_time(400.0, 1000.0, false), 400.0);
        assert_eq!(normalize_time(2000.0, 1000.0, false), 1000.0);
        assert_eq!(normalize_time(1500.0, 1000.0, true), 500.0);
        assert_eq!(normalize_time(-250.0, 1000.0, true), 750.0);
        assert_eq!(normalize_time(500.0, 0.0, false), 0.0);
    }

    fn node_binding(id: &str, prop: &str, keys: Vec<Key>) -> Binding {
        Binding {
            target: Target { object: ObjectRef::Node { id: id.into() }, prop: prop.into() },
            curve: time_curve(keys),
        }
    }

    fn timeline(bindings: Vec<Binding>, duration: f64, looping: Option<bool>) -> Timeline {
        Timeline { id: "t".into(), duration, looping, bindings }
    }

    // --- evaluate_timeline ---
    #[test]
    fn evaluate_folds_node_and_clamps_and_loops() {
        let tl = timeline(
            vec![
                node_binding("n1", "x", vec![k(0.0, 0.0), k(1000.0, 200.0)]),
                node_binding("n1", "opacity", vec![k(0.0, 0.0), k(1000.0, 1.0)]),
            ],
            1000.0,
            None,
        );
        let out = evaluate_timeline(&tl, &ctx(500.0, &[]));
        let n1 = out.get("n1").unwrap();
        assert!((n1["x"] - 100.0).abs() < 1e-6);
        assert!((n1["opacity"] - 0.5).abs() < 1e-6);

        // clamp past the end
        let clamp = timeline(vec![node_binding("n1", "x", vec![k(0.0, 0.0), k(1000.0, 100.0)])], 1000.0, None);
        assert!((evaluate_timeline(&clamp, &ctx(2000.0, &[]))["n1"]["x"] - 100.0).abs() < 1e-6);
        // wrap when looping
        let looped = timeline(vec![node_binding("n1", "x", vec![k(0.0, 0.0), k(1000.0, 100.0)])], 1000.0, Some(true));
        assert!((evaluate_timeline(&looped, &ctx(1500.0, &[]))["n1"]["x"] - 50.0).abs() < 1e-6);
    }

    #[test]
    fn evaluate_param_domain_and_skips_non_node_and_empty() {
        // param-domain binding driven by a live parameter
        let tl = timeline(
            vec![Binding {
                target: Target { object: ObjectRef::Node { id: "n1".into() }, prop: "rotation".into() },
                curve: Curve { domain: Domain::Param { param: "yaw".into() }, keys: vec![k(-1.0, -30.0), k(1.0, 30.0)] },
            }],
            0.0,
            None,
        );
        assert!((evaluate_timeline(&tl, &ctx(9999.0, &[("yaw", 1.0)]))["n1"]["rotation"] - 30.0).abs() < 1e-6);

        // bone target is skipped in the node fold
        let bone = timeline(
            vec![Binding {
                target: Target { object: ObjectRef::Bone { id: "arm".into() }, prop: "rotation".into() },
                curve: time_curve(vec![k(0.0, 45.0)]),
            }],
            0.0,
            None,
        );
        assert!(evaluate_timeline(&bone, &ctx(0.0, &[])).is_empty());

        // an empty curve contributes no node
        let empty = timeline(vec![node_binding("n1", "x", vec![])], 0.0, None);
        assert!(!evaluate_timeline(&empty, &ctx(0.0, &[])).contains_key("n1"));
    }

    // --- serialization round-trip + version gate ---
    #[test]
    fn serialize_round_trip_and_version_gate() {
        let doc = AnimDoc {
            params: vec![Param { id: "p1".into(), kind: ParamKind::Number, value: Some(0.0), min: Some(0.0), max: Some(1.0) }],
            timelines: vec![timeline(vec![node_binding("s1", "x", vec![k(0.0, 0.0), k(1000.0, 200.0)])], 1000.0, None)],
        };
        let back = deserialize_anim_doc(&serialize_anim_doc(&doc)).unwrap();
        assert_eq!(back, doc);

        let bumped = "{\"version\":99,\"doc\":{\"params\":[],\"timelines\":[]}}";
        let err = deserialize_anim_doc(&bumped).unwrap_err();
        assert!(err.0.contains("unsupported format version"));
    }

    /// Cross-language parity: deserialize the EXACT JSON the TS serializer emits
    /// (from serialize.test.ts's fixture) and evaluate it to the same values.
    #[test]
    fn deserializes_the_ts_contract() {
        let ts_json = r#"{"version":0,"doc":{"params":[{"id":"p1","kind":"number","value":0,"min":0,"max":1}],"timelines":[{"id":"tl-s1","duration":1000,"bindings":[{"target":{"object":{"kind":"node","id":"s1"},"prop":"x"},"curve":{"domain":{"kind":"time"},"keys":[{"at":0,"value":0},{"at":1000,"value":200,"interp":"easeOut"}]}},{"target":{"object":{"kind":"node","id":"s1"},"prop":"rotation"},"curve":{"domain":{"kind":"param","param":"p1"},"keys":[{"at":0,"value":0},{"at":1,"value":90}]}}]}]}}"#;
        let doc = deserialize_anim_doc(ts_json).expect("TS contract must deserialize");
        assert_eq!(doc.params.len(), 1);
        assert_eq!(doc.timelines.len(), 1);

        // time=0 → x at the start = 0; param p1=0.5 → rotation linear 0..90 = 45.
        let out = evaluate_timeline(&doc.timelines[0], &ctx(0.0, &[("p1", 0.5)]));
        let s1 = out.get("s1").unwrap();
        assert!((s1["x"] - 0.0).abs() < 1e-6);
        assert!((s1["rotation"] - 45.0).abs() < 1e-6);

        // time=1000 → x clamps to 200; p1=1 → rotation = 90.
        let out2 = evaluate_timeline(&doc.timelines[0], &ctx(1000.0, &[("p1", 1.0)]));
        let s1b = out2.get("s1").unwrap();
        assert!((s1b["x"] - 200.0).abs() < 1e-6);
        assert!((s1b["rotation"] - 90.0).abs() < 1e-6);
    }
}
