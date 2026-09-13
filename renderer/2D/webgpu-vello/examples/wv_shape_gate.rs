//! The WORK gate: the pixel gates (crop oracle, battery, edge-stale) prove what a frame draws,
//! not what it costs — 135 regions and 4075 draws for one glass at the viewport edge shipped
//! through all of them green. This gate renders the editor showcase twice at device zoom 1.5 —
//! the glass at rest inside the frame, then crossing the left edge — and fails when the frame's
//! shape (regions, draws, fine windows, rounds) grows past the ceilings written here.
//!
//! The ceilings are the CURRENT numbers, not targets: they only ever move down, and a phase that
//! wants to move them must say why in its commit. Run:
//! `cargo run --release --example wv_shape_gate` (`WV_SHAPE_PRINT=1` prints the frame lines).

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

#[path = "util/replay.rs"]
mod replay_util;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 2560;
const H: u32 = 1086;
const ZOOM: f32 = 1.5;
const EDITOR_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/showcase-editor.abi.json");

/// One view and the most the frame may cost there: `(regions, draws, windows, rounds)`.
struct Ceiling {
    name: &'static str,
    pan: (f32, f32),
    max: [u32; 4],
}

fn ceilings() -> Vec<Ceiling> {
    vec![
        Ceiling { name: "glass-at-rest", pan: (0.0, 0.0), max: [8, 303, 18, 20] },
        Ceiling { name: "glass-crossing-left", pan: (-450.0, -165.0), max: [157, 4763, 70, 71] },
    ]
}

#[derive(Clone, Copy, Default, Debug)]
struct Shape {
    regions: u32,
    draws: u32,
    windows: u32,
    rounds: u32,
}

fn parse(line: &str) -> Shape {
    let field = |key: &str| -> u32 {
        line.split_whitespace()
            .find_map(|tok| tok.strip_prefix(key).and_then(|v| v.parse().ok()))
            .unwrap_or_else(|| panic!("frame line lacks {key}: {line}"))
    };
    Shape {
        regions: field("regions="),
        draws: field("draws="),
        windows: field("windows="),
        rounds: field("rounds="),
    }
}

fn main() {
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_shape_gate"),
        ..Default::default()
    }))
    .expect("device");

    let rep = replay_util::replay(EDITOR_FIXTURE);
    println!("wv shape gate: {W}x{H} device zoom {ZOOM} (editor fixture: {} calls)", rep.applied);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    render_core::vello::frame_log::set_enabled(true);

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("shape gate target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    });
    let mut backend = ClassicBackend::new(&device);
    let mut sink = Sink::new(&device, FORMAT);
    backend.sync_fonts();
    backend.upload_pending_images();

    let print = std::env::var("WV_SHAPE_PRINT").is_ok();
    let mut failures = 0u32;
    for c in ceilings() {
        render_core::vello::abi::set_view(ZOOM, c.pan.0, c.pan.1);
        let mut shape = Shape::default();
        for _ in 0..2 {
            sink.render_whole_viewport(&mut backend, &device, &queue, &target, Affine::IDENTITY, W, H, true);
            device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
            let line = render_core::vello::frame_log::last_line();
            if print {
                println!("  {line}");
            }
            shape = parse(&line);
        }
        let got = [shape.regions, shape.draws, shape.windows, shape.rounds];
        let over = got.iter().zip(&c.max).any(|(g, m)| g > m);
        failures += u32::from(over);
        println!(
            "{:<22} {:<5} regions {:>4}/{:<4} draws {:>5}/{:<5} windows {:>3}/{:<3} rounds {:>3}/{:<3}",
            c.name,
            if over { "FAIL" } else { "PASS" },
            got[0], c.max[0], got[1], c.max[1], got[2], c.max[2], got[3], c.max[3],
        );
    }
    if failures > 0 {
        println!("\n{failures} view(s) FAILED — the frame does more work than its ceiling");
        std::process::exit(1);
    }
    println!("\nall views within their work ceilings");
}
