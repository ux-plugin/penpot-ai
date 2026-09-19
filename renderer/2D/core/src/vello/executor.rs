//! The executor: run a [`FramePlan`] and decide nothing.
//!
//! One store texture, bound once: the frame rows and the pages under them. Each pass is encoded
//! as it says: a `Clear` fills, a `Frontend` builds the scene the draw commands describe and runs
//! vello's front-end once, a `Fine` is one dispatch over its window's tiles with the store as the
//! only read and write, a `Copy` copies, a `Present` unpacks the frame rows onto the swapchain.
//! Nothing here reads the graph, the scene's effect stacks, or a node's neighbourhood.

use crate::kurbo::{Affine, Rect, Shape as _};
use crate::vello::frame_plan::{work_label, DrawCmd, FramePlan, Pass, Tiles};
use crate::vello::frame_graph::DrawStyle;
use crate::vello::rasterize::{RasterBackend, SEG_ALL};
use crate::vello::sink::Sink;
use vello_example_scenes::RenderingContext;

/// Store rows band into layers this tall, as `fine` addresses them.
const LAYER_PX: u32 = 8192;
/// How many times a plan is re-run after the front-end overflowed a pool before the frame is
/// left as it is (a pool the device cannot hold).
const MAX_RERUNS: u32 = 3;
/// The first debug bucket of the fine windows' GPU time by work kind.
const FINE_BUCKET: usize = 40;

/// The profiler bucket and label for a fine window's `work`.
fn fine_slot(work: u32) -> (usize, &'static str) {
    match work_label(work) {
        "resample" => (FINE_BUCKET, "fine:resample"),
        "warp" => (FINE_BUCKET + 1, "fine:warp"),
        "blur" => (FINE_BUCKET + 2, "fine:blur"),
        "scatter" => (FINE_BUCKET + 3, "fine:scatter"),
        "pointwise" => (FINE_BUCKET + 4, "fine:pointwise"),
        "draw" => (FINE_BUCKET + 5, "fine:draw"),
        "paint" => (FINE_BUCKET + 6, "fine:paint"),
        _ => (FINE_BUCKET + 7, "fine:mixed"),
    }
}

fn warn(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::warn_1(&wasm_bindgen::JsValue::from_str(msg));
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{msg}");
}

fn texels(r: Rect) -> [u32; 4] {
    [r.x0.round().max(0.0) as u32, r.y0.round().max(0.0) as u32, r.x1.round().max(0.0) as u32, r.y1.round().max(0.0) as u32]
}

fn packed_colour(c: [f32; 4]) -> u32 {
    crate::peniko::Color::new(c).premultiply().to_rgba8().to_u32()
}

impl Sink {
    /// Run `plan` for a `width × height` frame onto `target` (the swapchain texture). The plan's
    /// store width must equal the frame width; its frame rows are `[0, height)`.
    #[expect(clippy::too_many_arguments, reason = "the GPU context lives on the renderer wrapper")]
    pub fn run_plan<B: RasterBackend>(
        &mut self,
        plan: &FramePlan,
        backend: &mut B,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: &wgpu::Texture,
        root: Affine,
        width: u32,
        height: u32,
    ) {
        plan.validate().unwrap_or_else(|e| panic!("frame plan: {e}"));
        assert!(plan.store.0 >= width, "the store holds the frame's columns");
        assert!(plan.store.1 >= height, "the store holds the frame rows");
        crate::vello::frame_log::begin();
        self.raster_usage = backend.rasterize_target_usage();
        for tex in self.frame_transient.drain(..) {
            self.pool.release(tex);
        }
        self.frame_transient_views.clear();
        let full_view = crate::vello::abi::effective_view(root);
        self.last_view = Some(full_view);
        let sw_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let sz = (width as f32, height as f32);

        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame plan") });
        if !self.gpu_timer_tried {
            self.gpu_timer_tried = true;
            self.gpu_timer = crate::vello::gputime::GpuTimer::new(device, queue);
        }
        if let Some(t) = self.gpu_timer.as_mut() {
            t.begin();
            t.begin_pass(&mut enc, &sw_view);
        }
        if crate::vello::abi::prof_passes() && !self.pass_prof_tried {
            self.pass_prof_tried = true;
            self.pass_prof = crate::vello::gputime::PassProfiler::new(device, queue);
        }
        if let Some(p) = self.pass_prof.as_mut() {
            p.begin();
        }
        if self.store_ops.is_none() {
            self.store_ops = Some(crate::vello::store::StoreOps::new(device));
        }
        if self.bump_watch.is_none() {
            self.bump_watch = Some(crate::vello::bump_watch::BumpWatch::new(device));
        }
        if let Some(words) = self.bump_watch.as_mut().and_then(crate::vello::bump_watch::BumpWatch::take) {
            self.grow_pools(words, device);
        }
        backend.set_bump_sizes(self.bump_sizes);

        let (sw, sh) = plan.store;
        let usage = wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::RENDER_ATTACHMENT;
        let store_tex = self.pool.acquire_grid_target(device, sw, sh, wgpu::TextureFormat::R32Uint, usage, "wv store");
        let store_w = crate::vello::sink::storage_array_view(&store_tex);
        let store_l0 = crate::vello::sink::layer0_view(&store_tex);
        let store_sz = (sw as f32, store_tex.height() as f32);
        backend.set_frame_extent(width, plan.page);
        let params: Vec<u8> = plan.params.iter().flat_map(|f| f.to_le_bytes()).collect();
        let binding_limit = device.limits().max_storage_buffer_binding_size as usize;
        assert!(
            params.len() <= binding_limit,
            "frame plan params ({} bytes) exceed the device's storage binding limit ({binding_limit} bytes)",
            params.len()
        );

        let t_enc = crate::vello::prof::now();
        let mut in_session = false;
        for pass in &plan.passes {
            match pass {
                Pass::Clear { rect, colour } => {
                    backend.phase_flush(&mut enc);
                    let ops = self.store_ops.as_ref().expect("store ops built");
                    ops.fill(device, &mut enc, &store_w, texels(*rect), packed_colour(*colour));
                }
                Pass::Frontend { draws } => {
                    assert!(!in_session, "one Frontend per plan");
                    let t_scene = crate::vello::prof::now();
                    let mut scene = backend.new_scene(sw as u16, sh as u16);
                    let sdf_jobs = self.encode_draws(&mut scene, draws, backend, device, &mut enc, &store_tex);
                    let _ = sdf_jobs;
                    let t_begin = crate::vello::prof::now();
                    backend.phased_begin(&scene, device, queue, &mut enc, sw, sh, crate::vello::abi::background(), &params);
                    backend.phased_frontend_full(device, queue, &mut enc);
                    let t_front = crate::vello::prof::now();
                    crate::vello::prof::dbg_add(30, t_begin - t_scene);
                    crate::vello::prof::dbg_add(31, t_front - t_begin);
                    let [tiles, bins] = backend.phased_estimate();
                    crate::vello::prof::dbg_set(49, f64::from(tiles));
                    crate::vello::prof::dbg_set(50, f64::from(bins));
                    in_session = true;
                    if let Some(p) = self.pass_prof.as_mut() {
                        backend.phase_flush(&mut enc);
                        p.stamp(&mut enc, &store_l0, 0);
                    }
                }
                Pass::Fine { window, work } => {
                    assert!(in_session, "a Fine before the Frontend");
                    if let Tiles::List { off, n } = window.tiles {
                        if n == 0 {
                            continue;
                        }
                        backend.phase_sparse_window(off, n);
                    }
                    let hi = if window.rounds.1 == u32::MAX { SEG_ALL } else { window.rounds.1 };
                    crate::vello::frame_log::note_window();
                    crate::vello::sink::note_passes(2);
                    let (bucket, label) = fine_slot(*work);
                    backend.phased_fine(device, queue, &mut enc, window.rounds.0, hi, &store_w, label);
                    if let Some(p) = self.pass_prof.as_mut() {
                        backend.phase_flush(&mut enc);
                        p.stamp(&mut enc, &store_l0, bucket);
                    }
                }
                Pass::Copy { src, dst } => {
                    backend.phase_flush(&mut enc);
                    let ops = self.store_ops.as_ref().expect("store ops built");
                    let s = texels(*src);
                    ops.copy(device, &mut enc, &store_w, [s[0], s[1]], texels(*dst));
                }
                Pass::Present { from } => {
                    backend.phase_flush(&mut enc);
                    let f = texels(*from);
                    assert_eq!(f, [0, 0, width, height], "the frame rows are what is presented");
                    let page: u32 = std::env::var("WV_PRESENT_PAGE").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
                    if page > 0 {
                        let y = (page * height) as f32;
                        self.compositor.blit_packed(device, &mut enc, &sw_view, sz, &crate::vello::blend::Blit {
                            src: &store_l0,
                            dst: (0.0, 0.0, sz.0, sz.1),
                            src_rect: (0.0, y, sz.0, sz.1),
                            src_size: store_sz,
                            alpha: 1.0,
                        });
                    } else {
                        self.present_final(&mut enc, device, &sw_view, &store_l0, width, height, wgpu::TextureFormat::Rgba8Unorm, sz, store_sz, full_view);
                    }
                }
            }
        }
        if in_session {
            backend.phase_flush(&mut enc);
            if let Some(dst) = self.bump_watch.as_mut().and_then(crate::vello::bump_watch::BumpWatch::begin) {
                backend.phased_bump_copy(&mut enc, dst);
            }
            backend.phased_finish(device, queue, &mut enc);
        }
        let t_end = crate::vello::prof::now();
        crate::vello::prof::dbg_add(29, t_end - t_enc);
        crate::vello::prof::add_render(t_end - t_enc);
        crate::vello::frame_log::set_phases(crate::vello::frame_log::Phases { encode: t_end - t_enc, ..Default::default() });
        let shape = plan.shape();
        crate::vello::frame_log::set_shape(crate::vello::frame_log::Shape {
            dag_nodes: 0,
            rounds: shape.rounds,
            gathers: 0,
            regions: shape.rects,
            leases: shape.rects,
            marks: shape.markers,
            draws: shape.draws,
            windows: 0,
        });

        if let Some(p) = self.pass_prof.as_mut() {
            p.resolve(&mut enc);
        }
        if let Some(t) = self.gpu_timer.as_mut() {
            t.end(&mut enc, &sw_view);
            t.resolve(&mut enc);
        }
        crate::vello::prof::inc_submit();
        let t_sub = crate::vello::prof::now();
        queue.submit([enc.finish()]);
        crate::vello::prof::add_submit(crate::vello::prof::now() - t_sub);
        backend.after_submit();
        if let Some(t) = self.gpu_timer.as_mut() {
            t.after_submit();
        }
        if let Some(p) = self.pass_prof.as_mut() {
            p.after_submit();
        }
        if let Some(b) = self.bump_watch.as_mut() {
            b.after_submit();
        }
        crate::vello::frame_log::end();
        self.frame_transient.push(store_tex);
        backend.set_frame_extent(0, 0);

        #[cfg(not(target_arch = "wasm32"))]
        {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            if let Some(words) = self.bump_watch.as_mut().and_then(crate::vello::bump_watch::BumpWatch::take) {
                if self.grow_pools(words, device) && self.reruns < MAX_RERUNS {
                    self.reruns += 1;
                    self.run_plan(plan, backend, device, queue, target, root, width, height);
                    return;
                }
            }
        }
        self.reruns = 0;
    }

    /// Raise every pool floor to what `words` (the front-end's allocator words) say a frame needed,
    /// with a quarter of headroom, when the frame overflowed. Nothing changes without the failed
    /// flag. Returns whether a floor rose: a pool already at the device's binding limit cannot.
    fn grow_pools(&mut self, words: [u32; 8], device: &wgpu::Device) -> bool {
        if words[0] == 0 {
            return false;
        }
        let cap = u64::from(device.limits().max_storage_buffer_binding_size);
        let fit = |need: u32, bytes_each: u64| -> u32 {
            let want = u64::from(need) + u64::from(need) / 4;
            want.min(cap / bytes_each).min(u64::from(u32::MAX)) as u32
        };
        let before = self.bump_sizes;
        let s = &mut self.bump_sizes;
        s.bin_data = s.bin_data.max(fit(words[1], 4));
        s.ptcl = s.ptcl.max(fit(words[2], 4));
        s.tiles = s.tiles.max(fit(words[3], 8));
        s.seg_counts = s.seg_counts.max(fit(words[4], 8));
        s.segments = s.segments.max(fit(words[5], 24));
        s.lines = s.lines.max(fit(words[7], 24));
        crate::vello::prof::dbg_add(48, 1.0);
        let grew = *s != before;
        warn(&format!(
            "wv: front-end overflow failed={:#x} binning={} ptcl={} tiles={} seg_counts={} segments={} lines={} → pools {:?}{}",
            words[0], words[1], words[2], words[3], words[4], words[5], words[7], s,
            if grew { "" } else { " (at the device's limit, not grown)" }
        ));
        grew
    }

    /// Encode a `Frontend`'s draw commands into `scene`: bodies as their subtrees through the
    /// backend's walk, coverages as white silhouettes, markers as `CMD_EFFECT` boundaries — and
    /// bake every distance item straight into its store rect (it is not a vello draw).
    fn encode_draws<B: RasterBackend>(
        &mut self,
        scene: &mut B::Scene,
        draws: &[DrawCmd],
        backend: &mut B,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        store_tex: &wgpu::Texture,
    ) -> usize {
        let mut baked = 0usize;
        for cmd in draws {
            match cmd {
                DrawCmd::Clip { rect } => {
                    scene.set_transform(Affine::IDENTITY);
                    scene.push_clip_layer(&rect.to_path(0.1));
                }
                DrawCmd::Unclip => scene.pop_layer(),
                DrawCmd::Shapes { items, transform } => {
                    for it in items {
                        let t0 = crate::vello::prof::now();
                        match it.style {
                            DrawStyle::Body => {
                                backend.draw_shape(scene, *transform, it.shape);
                                crate::vello::prof::dbg_add(32, crate::vello::prof::now() - t0);
                            }
                            DrawStyle::Coverage { spread, .. } => {
                                backend.draw_coverage(scene, *transform, it.shape, spread);
                                crate::vello::prof::dbg_add(33, crate::vello::prof::now() - t0);
                            }
                            DrawStyle::Distance { decode } => {
                                self.bake_distance(device, enc, store_tex, it.shape, *transform, it.bounds, decode, backend);
                                baked += 1;
                                crate::vello::prof::dbg_add(34, crate::vello::prof::now() - t0);
                            }
                        }
                    }
                }
                DrawCmd::Marker { shape, transform, eid, seg_after, round, footprint, ctl, params_off } => {
                    let t0 = crate::vello::prof::now();
                    let f = *footprint;
                    backend.draw_effect_marker(
                        scene,
                        *transform,
                        *shape,
                        *eid,
                        *seg_after,
                        *round,
                        *params_off,
                        [f.x0 as f32, f.y0 as f32, f.x1 as f32, f.y1 as f32],
                        *ctl,
                    );
                    crate::vello::prof::dbg_add(35, crate::vello::prof::now() - t0);
                }
            }
        }
        baked
    }

    /// Bake `shape`'s outline distance into the store rect its item's bounds land on under
    /// `transform`, a slice per store layer the rect crosses.
    #[expect(clippy::too_many_arguments, reason = "one bake is device context + target + shape + placement")]
    fn bake_distance<B: RasterBackend>(
        &mut self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        store_tex: &wgpu::Texture,
        shape: u128,
        transform: Affine,
        bounds: Rect,
        decode: f32,
        backend: &mut B,
    ) {
        let segments = crate::vello::abi::with_scene(|live, viewport, modifiers| {
            let n = live.get(shape)?;
            let m = modifiers.get(&shape).copied().unwrap_or(Affine::IDENTITY);
            Some(crate::vello::sdf::flatten_segments(&(transform * viewport * m * crate::geometry::outline(n)), 0.3))
        });
        let Some(segments) = segments else { return };
        let r = texels(transform.transform_rect_bbox(bounds));
        if r[3] <= r[1] || r[2] <= r[0] {
            return;
        }
        backend.phase_flush(enc);
        if self.sdf_baker.is_none() {
            self.sdf_baker = Some(crate::vello::sdf::SdfBaker::new(device));
        }
        let baker = self.sdf_baker.as_ref().expect("sdf baker built");
        // The packer places values without regard to where one store layer ends and the next
        // begins, and a bake renders into one layer's view: a rect that straddles a boundary is
        // baked a slice per layer. Every texel's distance depends only on its own position and
        // the whole outline, so the slices join exactly.
        for layer in r[1] / LAYER_PX..=(r[3] - 1) / LAYER_PX {
            let base = layer * LAYER_PX;
            let (y0, y1) = (r[1].max(base), r[3].min(base + LAYER_PX));
            let view = store_tex.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2),
                base_array_layer: layer,
                array_layer_count: Some(1),
                ..Default::default()
            });
            let local: Vec<[f32; 4]> = segments.iter().map(|s| [s[0], s[1] - base as f32, s[2], s[3] - base as f32]).collect();
            baker.bake_into(device, enc, &view, &local, (r[0], y0 - base, r[2] - r[0], y1 - y0), decode, false);
            self.frame_transient_views.push(view);
        }
    }
}
