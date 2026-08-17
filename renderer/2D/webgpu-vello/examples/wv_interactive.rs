//! How does the whole-viewport path hold up on a real document that is being *used*?
//!
//! Every other harness here renders a dozen shapes, once, standing still. That measures effect cost
//! and nothing else. A document under editing has thousands of shapes, only a minority of them
//! carrying effects, and the view rarely holds still — so this drives four phases over the same
//! scene and reports each separately:
//!
//! - **static**   — the same frame repeatedly. The floor: no view change, no edit.
//! - **zoom**     — the view scale changes every frame.
//! - **pan**      — the view translates every frame.
//! - **moving**   — a slice of the shapes gets a fresh gesture transform every frame, the way a drag
//!                  does, through the real `set_modifiers` wire path rather than a scene rebuild.
//!
//! CPU-record and GPU-wait are split (see `wv_effect_perf`), because these phases stress different
//! halves: a view change invalidates caching and re-encodes, while a drag only moves a few shapes.
//!
//! Run: `cargo run --release --example wv_interactive`
//! Knobs: `SHAPES` (default 4000), `EFFECT_EVERY` (default 25), `W`/`H` (default 4K).

use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const WARMUP: usize = 3;
const TIMED: usize = 12;

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// Hand `set_modifiers` a gesture transform for `ids`, through the real wire format (40-byte entries:
/// the uuid quartet then `a,b,c,d,e,f`) so this exercises the same path a drag in the editor takes.
fn push_modifiers(entries: &[(u128, f64, f64)]) {
    let mut bytes = Vec::with_capacity(entries.len() * 40);
    for &(id, dx, dy) in entries {
        let (a, b, c, d) = render_core::vello::abi::uuid_to_quartet(id);
        for w in [a, b, c, d] {
            bytes.extend_from_slice(&w.to_le_bytes());
        }
        for f in [1.0f32, 0.0, 0.0, 1.0, dx as f32, dy as f32] {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
    }
    let ptr = render_core::vello::abi::alloc_bytes(bytes.len());
    // SAFETY: `alloc_bytes` returned an allocation of exactly this size, which `set_modifiers` drains.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    render_core::vello::abi::set_modifiers();
}

struct Phase {
    name: &'static str,
    detail: &'static str,
}

fn main() {
    let (w, h) = (env_u32("W", 3840), env_u32("H", 2160));
    let shapes = env_u32("SHAPES", 4000);
    let effect_every = env_u32("EFFECT_EVERY", 25);

    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok() else {
        eprintln!("no adapter");
        return;
    };
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("interactive"), ..Default::default() })).expect("device");
    let mut backend = ClassicBackend::new(&device);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("interactive target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });

    // Install once. The phases below drive the view and the modifiers, NOT a rebuild — re-installing
    // per frame would measure fixture construction rather than rendering.
    render_core::vello::abi::load_scale_scene(shapes, effect_every);
    let cells = render_core::parity::canvas_size(1);
    let fit = (w as f32 / cells.0 as f32).min(h as f32 / cells.1 as f32);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    backend.sync_fonts();
    backend.upload_pending_images();

    let with_effects = if effect_every > 0 { shapes / effect_every } else { 0 };
    println!(
        "{shapes} shapes ({with_effects} with effects, 1 in {effect_every}), overlapping, at {w}x{h}\n"
    );
    println!("{:<9} {:>10} {:>10} {:>10} {:>9} {:>8}  {}", "phase", "median ms", "cpu ms", "gpu ms", "rasters", "graphs", "what moves");

    let phases = [
        Phase { name: "static", detail: "nothing — the floor" },
        Phase { name: "zoom", detail: "view scale every frame" },
        Phase { name: "pan", detail: "view translation every frame" },
        Phase { name: "moving", detail: "200 shapes dragged every frame" },
    ];

    let root = Affine::IDENTITY;
    for (mode_name, phased) in [("per-segment", 0u32), ("front-end-once", 1u32)] {
    println!("-- {mode_name}");
    for (pi, phase) in phases.iter().enumerate() {
        let mut sink = Sink::new(&device, FORMAT);
        let (mut tot, mut rec) = (Vec::new(), Vec::new());
        let (mut rasters, mut graphs) = (0.0, 0.0);
        for i in 0..(WARMUP + TIMED) {
            let t = i as f32;
            match pi {
                // Static: fixed view, no modifiers. Still marked dirty so the present-on-demand gate
                // does not simply re-blit the retained canvas and report a fictional 0 ms.
                0 => {
                    render_core::vello::abi::set_view(fit, 0.0, 0.0);
                    render_core::vello::abi::mark_dirty();
                }
                1 => render_core::vello::abi::set_view(fit * (1.0 + 0.03 * (t % 8.0)), 0.0, 0.0),
                2 => render_core::vello::abi::set_view(fit, -12.0 * (t % 10.0), -7.0 * (t % 10.0)),
                _ => {
                    render_core::vello::abi::set_view(fit, 0.0, 0.0);
                    // Ids are sequential from the fixture builder; drag a contiguous slice of them.
                    let moved: Vec<(u128, f64, f64)> = (1u128..=200)
                        .map(|id| (id, f64::from(t) * 1.5, f64::from(t) * -1.1))
                        .collect();
                    push_modifiers(&moved);
                }
            }
            render_core::vello::abi::set_wv_phased(phased);
            render_core::vello::abi::set_cmd_effect(phased);
            render_core::vello::prof::reset();
            let t0 = Instant::now();
            let _ = render_core::vello::abi::take_dirty();
            sink.render_whole_viewport(&mut backend, &device, &queue, &target, root, w, h, true);
            let r = t0.elapsed().as_secs_f64() * 1000.0;
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            let total = t0.elapsed().as_secs_f64() * 1000.0;
            if i >= WARMUP {
                tot.push(total);
                rec.push(r);
                rasters = render_core::vello::prof::read(7);
                graphs = render_core::vello::prof::read(14);
            }
        }
        tot.sort_by(|a, b| a.partial_cmp(b).unwrap());
        rec.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let (median, cpu) = (tot[tot.len() / 2], rec[rec.len() / 2]);
        println!(
            "{:<9} {median:>10.1} {cpu:>10.1} {:>10.1} {rasters:>9.0} {graphs:>8.0}  {}",
            phase.name,
            median - cpu,
            phase.detail,
        );
        // Leave the modifiers clean so the next phase starts from rest.
        render_core::vello::abi::clean_modifiers();
    }
    }
    println!("\n60 fps is 16.7 ms. CPU-heavy phases point at the per-shape walk and encoding rebuild;");
    println!("GPU-heavy ones at the effect passes.");
}
