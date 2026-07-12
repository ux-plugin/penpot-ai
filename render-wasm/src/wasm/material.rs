use crate::mem;
use crate::render::ssa::material::compile_and_reflect;
use crate::shapes::{Material, UniformSlot, UniformValue};
use crate::{with_current_shape_mut, STATE};

/// Shared-memory layout (little-endian) staged by the TS `setShapeMaterial`:
///   [u32 hidden]
///   [u32 source_len] [source bytes] [pad → 4B]
///   [u32 uniform_count]
///   per uniform: [u32 name_len] [name bytes] [pad → 4B] [u32 comp] [comp × f32]
///
/// `comp` is the component count (1..=4) → `F32`/`Vec2`/`Vec3`/`Vec4`. A
/// truncated/garbled buffer parses to `None` (material cleared) rather than
/// panicking — same defensive stance as `set_shape_noise`.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn u32(&mut self) -> Option<u32> {
        let s = self.buf.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }

    fn f32(&mut self) -> Option<f32> {
        Some(f32::from_bits(self.u32()?))
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.buf.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(s)
    }

    fn align4(&mut self) {
        self.pos = (self.pos + 3) & !3;
    }
}

fn parse_material(bytes: &[u8]) -> Option<Material> {
    let mut r = Reader::new(bytes);
    let hidden = r.u32()? != 0;
    let source_len = r.u32()? as usize;
    let source = String::from_utf8(r.take(source_len)?.to_vec()).ok()?;
    r.align4();

    let count = r.u32()? as usize;
    let mut uniforms = Vec::with_capacity(count);
    for _ in 0..count {
        let name_len = r.u32()? as usize;
        let name = String::from_utf8(r.take(name_len)?.to_vec()).ok()?;
        r.align4();
        let value = match r.u32()? {
            1 => UniformValue::F32(r.f32()?),
            2 => UniformValue::Vec2([r.f32()?, r.f32()?]),
            3 => UniformValue::Vec3([r.f32()?, r.f32()?, r.f32()?]),
            4 => UniformValue::Vec4([r.f32()?, r.f32()?, r.f32()?, r.f32()?]),
            _ => return None,
        };
        uniforms.push(UniformSlot { name, value });
    }

    Some(Material {
        source,
        uniforms,
        hidden,
    })
}

#[no_mangle]
pub extern "C" fn set_shape_material() {
    let bytes = mem::bytes();
    let material = parse_material(&bytes);
    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.set_material(material.clone());
    });
    let _ = mem::free_bytes();
}

#[no_mangle]
pub extern "C" fn clear_shape_material() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.set_material(None);
    });
}

fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn push_str(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    push_u32(out, b.len() as u32);
    out.extend_from_slice(b);
}

/// Compile the SkSL source staged in shared memory (raw UTF-8, no header) and
/// return a pointer to a freshly-staged result buffer for the editor to read
/// then free. Result layout (little-endian):
///   [u32 ok]
///   [u32 error_len][error bytes]
///   [u32 uniform_count]
///   per uniform: [u32 name_len][name bytes][u32 components][u32 is_color][u32 count]
///   [u32 input_count]
///   per input: [u32 name_len][name bytes]
#[no_mangle]
pub extern "C" fn compile_material() -> u32 {
    let src_bytes = mem::bytes_or_empty();
    let src = String::from_utf8_lossy(&src_bytes);
    let result = compile_and_reflect(&src);

    let mut out = Vec::new();
    push_u32(&mut out, if result.ok { 1 } else { 0 });
    push_str(&mut out, result.error.as_deref().unwrap_or(""));
    push_u32(&mut out, result.uniforms.len() as u32);
    for u in &result.uniforms {
        push_str(&mut out, &u.name);
        push_u32(&mut out, u.components);
        push_u32(&mut out, if u.is_color { 1 } else { 0 });
        push_u32(&mut out, u.count);
    }
    push_u32(&mut out, result.inputs.len() as u32);
    for name in &result.inputs {
        push_str(&mut out, name);
    }

    mem::write_bytes(out) as u32
}
