//! A user-authored SkSL shader fill ("material") attached to a single shape.
//!
//! The shape's fill becomes the output of a custom `RuntimeEffect`. This is the
//! single-shape case only — no backdrop sampling and no field/interaction yet.
//! The `source` is compiled and cached in `render::material`; the `uniforms`
//! here are bound generically by name via reflection over `effect.uniforms()`,
//! so adding a `uniform` to the source surfaces a slot here without any
//! per-effect Rust wiring (unlike `glass`/`noise`).

/// A single uniform value supplied from the editor/UI, kept type-tagged so the
/// generic binder can copy the right number of `f32`s into the uniform buffer.
/// SkSL runtime-effect uniform data is float-backed, so `half`/`float` types
/// alike are written as `f32` here.
#[derive(Debug, Clone, PartialEq)]
pub enum UniformValue {
    F32(f32),
    Vec2([f32; 2]),
    Vec3([f32; 3]),
    Vec4([f32; 4]),
}

/// A named uniform value, matched against the shader's declared uniforms by
/// name during binding. Unknown names are ignored; missing ones stay zeroed.
#[derive(Debug, Clone, PartialEq)]
pub struct UniformSlot {
    pub name: String,
    pub value: UniformValue,
}

#[derive(Debug, Clone)]
pub struct Material {
    /// SkSL source. Compiled (and cached by source hash) in `render::material`.
    pub source: String,
    /// User/UI-driven uniform values. Engine-owned uniforms (`u_resolution`,
    /// `u_scale`, …) are NOT stored here — the renderer fills those itself.
    pub uniforms: Vec<UniformSlot>,
    pub hidden: bool,
}

impl Material {
    pub fn new(source: String) -> Self {
        Self {
            source,
            uniforms: Vec::new(),
            hidden: false,
        }
    }
}
