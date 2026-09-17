//! The browser bench's glass stacks (`bench.html?n=&stack=&stacks=&stackBetween=&stackHalf=`) built
//! through the same ABI calls, so a native harness sees the scene the wasm build renders.

use render_core::vello::abi;

const CELL: f32 = 40.0;
const REC: usize = 164;

fn solid_fill(color: u32) {
    let size = 4 + REC;
    let ptr = abi::alloc_bytes(size);
    let bytes = unsafe { std::slice::from_raw_parts_mut(ptr, size) };
    bytes.fill(0);
    bytes[0] = 1;
    bytes[8..12].copy_from_slice(&color.to_le_bytes());
    abi::set_shape_fills();
}

/// `n` plain shapes on a grid, then `stacks` groups of `stack` nested glass shapes centred on a
/// `w × h` frame, `between` small shapes under each glass, the outermost glass `half` px in
/// half-extent. Reads the env the bench's URL parameters map to: `N`, `STACK`, `STACKS`,
/// `BETWEEN`, `HALF`, `EFFECTS` (`shadow` | `blur` | `both`), `EVERY`, `SIGMA` (the layer
/// blur's page sigma, default 6).
pub fn build_from_env(w: u32, h: u32) -> (u32, u32, u32, u32) {
    let env = |k: &str, d: f32| std::env::var(k).ok().and_then(|v| v.parse::<f32>().ok()).unwrap_or(d);
    let n = env("N", 2000.0) as u32;
    let stack = env("STACK", 6.0) as u32;
    let stacks = env("STACKS", 1.0) as u32;
    let between = env("BETWEEN", 0.0) as u32;
    let half0 = env("HALF", 400.0);
    let effects = std::env::var("EFFECTS").unwrap_or_default();
    let every = env("EVERY", 10.0).max(1.0) as u32;
    let sigma = env("SIGMA", 6.0);
    abi::init_shapes_pool((n + stacks * stack * (1 + between) + 200 + 32) as usize);
    let cols = (n as f32).sqrt().ceil() as u32;
    for i in 0..n {
        let (cx, cy) = (((i % cols) as f32) * CELL, ((i / cols) as f32) * CELL);
        abi::use_shape(0, 0, 0, i + 1);
        abi::set_shape_type(3);
        abi::set_shape_selrect(cx + 2.0, cy + 2.0, cx + CELL - 2.0, cy + CELL - 2.0);
        solid_fill(0xff00_0000 | (i.wrapping_mul(2_654_435_761) & 0x00ff_ffff));
        if !effects.is_empty() && i % every == 0 {
            if effects == "shadow" || effects == "both" {
                abi::add_shape_shadow(0x8000_0000, 8.0, 0.0, 4.0, 4.0, 0, false);
            }
            if effects == "blur" || effects == "both" {
                abi::set_shape_blur(0, false, sigma);
            }
        }
        abi::use_shape(0, 0, 0, 0);
        abi::add_shape_child(0, 0, 0, i + 1);
    }
    let mut id = n + stack + 100;
    let gc = (stacks as f32).sqrt().ceil().max(1.0) as u32;
    for g in 0..stacks {
        let gx = ((g % gc) as f32 + 0.5) * w as f32 / gc as f32;
        let gy = ((g / gc) as f32 + 0.5) * h as f32 / gc as f32;
        for s in 0..stack {
            let half = half0 - s as f32 * 18.0;
            for k in 0..between {
                let span = (2.0 * half - 48.0).max(1.0);
                let rx = gx - half + 12.0 + ((k * 53) as f32 % span);
                let ry = gy - half + 12.0 + ((k * 97) as f32 % span);
                abi::use_shape(0, 0, 0, id);
                abi::set_shape_type(3);
                abi::set_shape_selrect(rx, ry, rx + 26.0, ry + 26.0);
                solid_fill(0xff00_0000 | ((g * 7919 + s * 104_729 + k * 40_503) & 0x00ff_ffff));
                abi::use_shape(0, 0, 0, 0);
                abi::add_shape_child(0, 0, 0, id);
                id += 1;
            }
            abi::use_shape(0, 0, 0, id);
            abi::set_shape_type(3);
            abi::set_shape_selrect(gx - half, gy - half, gx + half, gy + half);
            abi::set_shape_glass(0, 4.0, 8.0, 1.5, 0.0, 0.4, 1.0, 0.2, 0.0, 0.0, 0.0, 1.0, 6.0, 3.0, 1.0, 0, 0);
            abi::use_shape(0, 0, 0, 0);
            abi::add_shape_child(0, 0, 0, id);
            id += 1;
        }
    }
    (n, stack, stacks, between)
}
