//! The render-facing runtime session — the layer the wasm FFI is a thin shell
//! over. A `Session` owns the loaded document, the node ordering, live parameter
//! values, and a **pre-allocated output buffer**. `eval` fills that buffer in
//! place each frame (node-major, fixed prop slots), so the frame loop never
//! allocates and therefore never grows wasm memory — the discipline that keeps a
//! JS `HEAPF32` view valid across frames.
//!
//! All the logic lives here (host-testable); the FFI in render-wasm just calls
//! `load` / `set_param` / `eval` / `node_ids` and hands JS the buffer pointer.

use std::collections::HashMap;

use crate::{deserialize_anim_doc, evaluate_timeline, AnimDoc, EvalContext, FormatError};

/// The render-facing property slots, in buffer order. A `NaN` in a slot means
/// "no change this frame" (the property isn't animated). These are the transform/
/// opacity channels the TS modifier adapter composes; the core stays prop-agnostic.
pub const PROPS: [&str; 6] = ["x", "y", "rotation", "scaleX", "scaleY", "opacity"];

/// One loaded animation, ready to evaluate frame by frame.
pub struct Session {
    doc: AnimDoc,
    /// Node ids in buffer-record order (first-appearance across bindings).
    node_ids: Vec<String>,
    node_index: HashMap<String, usize>,
    /// Live parameter values, keyed by id.
    params: HashMap<String, f64>,
    /// Parameter ids by index (doc.params order) — the index the FFI sets by.
    param_ids: Vec<String>,
    /// Pre-allocated output: `node_ids.len() * PROPS.len()` floats. Reused every frame.
    out: Vec<f32>,
}

impl Session {
    /// Parse the format contract and pre-allocate the frame buffer.
    pub fn load(json: &str) -> Result<Session, FormatError> {
        let doc = deserialize_anim_doc(json)?;
        Ok(Session::from_doc(doc))
    }

    /// Build a session from an already-parsed document.
    pub fn from_doc(doc: AnimDoc) -> Session {
        let mut node_ids: Vec<String> = Vec::new();
        let mut node_index: HashMap<String, usize> = HashMap::new();
        for tl in &doc.timelines {
            for b in &tl.bindings {
                if !b.target.object.is_node() {
                    continue;
                }
                let id = b.target.object.id();
                if !node_index.contains_key(id) {
                    node_index.insert(id.to_string(), node_ids.len());
                    node_ids.push(id.to_string());
                }
            }
        }

        let mut params: HashMap<String, f64> = HashMap::new();
        let mut param_ids: Vec<String> = Vec::new();
        for p in &doc.params {
            let v = p.value.unwrap_or_else(|| p.min.unwrap_or(0.0));
            params.insert(p.id.clone(), v);
            param_ids.push(p.id.clone());
        }

        let out = vec![f32::NAN; node_ids.len() * PROPS.len()];
        Session {
            doc,
            node_ids,
            node_index,
            params,
            param_ids,
            out,
        }
    }

    /// Node ids in buffer order — JS reads this once to map record `i` to a shape.
    pub fn node_ids(&self) -> &[String] {
        &self.node_ids
    }

    /// The frame buffer length in floats.
    pub fn buffer_len(&self) -> usize {
        self.out.len()
    }

    /// Update a live parameter value by its index (event-driven, not per frame).
    pub fn set_param(&mut self, index: usize, value: f64) {
        if let Some(id) = self.param_ids.get(index) {
            self.params.insert(id.clone(), value);
        }
    }

    /// Evaluate all timelines at `time` (+ current params) into the pre-allocated
    /// buffer: node-major, `PROPS`-order, `NaN` for an unanimated slot. Returns the
    /// buffer. Never allocates — the buffer is reused in place.
    pub fn eval(&mut self, time: f64) -> &[f32] {
        for v in self.out.iter_mut() {
            *v = f32::NAN;
        }
        let ctx = EvalContext {
            time,
            params: self.params.clone(),
        };
        for tl in &self.doc.timelines {
            for (node_id, props) in evaluate_timeline(tl, &ctx) {
                let Some(&ni) = self.node_index.get(&node_id) else {
                    continue;
                };
                let base = ni * PROPS.len();
                for (slot, name) in PROPS.iter().enumerate() {
                    if let Some(v) = props.get(*name) {
                        self.out[base + slot] = *v as f32;
                    }
                }
            }
        }
        &self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"{"version":0,"doc":{"params":[{"id":"p1","kind":"number","value":0,"min":0,"max":1}],"timelines":[{"id":"tl-s1","duration":1000,"bindings":[{"target":{"object":{"kind":"node","id":"s1"},"prop":"x"},"curve":{"domain":{"kind":"time"},"keys":[{"at":0,"value":0},{"at":1000,"value":200}]}},{"target":{"object":{"kind":"node","id":"s2"},"prop":"rotation"},"curve":{"domain":{"kind":"param","param":"p1"},"keys":[{"at":0,"value":0},{"at":1,"value":90}]}}]}]}}"#;

    fn slot(name: &str) -> usize {
        PROPS.iter().position(|p| *p == name).unwrap()
    }

    #[test]
    fn node_ids_are_first_appearance_order() {
        let s = Session::load(DOC).unwrap();
        assert_eq!(s.node_ids(), &["s1".to_string(), "s2".to_string()]);
        assert_eq!(s.buffer_len(), 2 * PROPS.len());
    }

    #[test]
    fn eval_fills_the_buffer_node_major_with_nan_for_unanimated() {
        let mut s = Session::load(DOC).unwrap();
        let out = s.eval(500.0); // x of s1 = 100; s2 rotation at param 0 = 0
        // s1 record
        assert!((out[slot("x")] - 100.0).abs() < 1e-4);
        assert!(out[slot("y")].is_nan());
        assert!(out[slot("opacity")].is_nan());
        // s2 record (rotation slot), param p1 still at its default 0 → 0
        let base = PROPS.len();
        assert!((out[base + slot("rotation")] - 0.0).abs() < 1e-4);
        assert!(out[base + slot("x")].is_nan());
    }

    #[test]
    fn set_param_drives_the_param_bound_node() {
        let mut s = Session::load(DOC).unwrap();
        s.set_param(0, 0.5); // p1 = 0.5 → s2 rotation = 45
        let out = s.eval(0.0);
        let base = PROPS.len();
        assert!((out[base + slot("rotation")] - 45.0).abs() < 1e-4);
    }

    #[test]
    fn eval_reuses_the_same_buffer_allocation() {
        // The buffer pointer must be stable across frames (pre-allocated once) —
        // this is what makes the JS HEAPF32 view safe frame to frame.
        let mut s = Session::load(DOC).unwrap();
        let p1 = s.eval(0.0).as_ptr();
        let p2 = s.eval(500.0).as_ptr();
        assert_eq!(p1, p2);
    }
}
