//! The executor: run a [`FramePlan`] and decide nothing.
//!
//! One store texture, bound once. Each pass is encoded as it says: a `Clear` fills, a `Frontend`
//! builds the scene the draw commands describe and runs vello's front-end once, a `Fine` is one
//! dispatch over its window with the store as the only read and write, a `Copy` copies, a
//! `Present` unpacks the frame rows onto the swapchain. Nothing here reads the graph, the scene's
//! effect stacks, or a node's neighbourhood.

use std::collections::HashMap;

use crate::kurbo::{Affine, Rect, Shape as _};
use crate::vello::frame_plan::{DrawCmd, FramePlan, Pass, Tiles};
use crate::vello::frame_graph::DrawStyle;
use crate::vello::rasterize::{fine_mode as fm, RasterBackend, SEG_ALL};
use crate::vello::sink::Sink;
use vello_example_scenes::RenderingContext;

/// Store rows band into layers this tall, as `fine` addresses them.
const LAYER_PX: u32 = 8192;

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
        assert_eq!(plan.store.0, width, "the store is the frame's width");
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
        if self.store_ops.is_none() {
            self.store_ops = Some(crate::vello::store::StoreOps::new(device));
        }

        let (sw, sh) = plan.store;
        let usage = wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::RENDER_ATTACHMENT;
        let store_tex = self.pool.acquire_grid_target(device, sw, sh, wgpu::TextureFormat::R32Uint, usage, "wv store");
        let store_w = crate::vello::sink::storage_array_view(&store_tex);
        let store_l0 = crate::vello::sink::layer0_view(&store_tex);
        let store_sz = (sw as f32, store_tex.height() as f32);
        backend.set_frame_extent(width, height);
        let params: Vec<u8> = plan.params.iter().flat_map(|f| f.to_le_bytes()).collect();

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
                    let mut scene = backend.new_scene(sw as u16, sh as u16);
                    let sdf_jobs = self.encode_draws(&mut scene, draws, backend, device, &mut enc, &store_tex);
                    let _ = sdf_jobs;
                    backend.phased_begin(&scene, device, queue, &mut enc, sw, sh, crate::vello::abi::background(), &params);
                    backend.phased_frontend_full(device, queue, &mut enc);
                    in_session = true;
                }
                Pass::Fine { window, output: _, base, input } => {
                    assert!(in_session, "a Fine before the Frontend");
                    let mut mode = fm::INIT_OUTPUT | fm::STAGING | fm::STG_TAPS | fm::KEYS_ROUND | fm::VALUE_READS;
                    if let Some(b) = base {
                        let b = texels(*b);
                        mode |= fm::BASE | fm::BASE_STORE;
                        backend.phase_base_rect([0, 0], [b[2] - b[0], b[3] - b[1]], [b[0], b[1]]);
                    }
                    if input.is_some() {
                        mode |= fm::INPUT;
                    }
                    if let Tiles::List { off, n } = window.tiles {
                        backend.phase_sparse_window(off, n);
                    }
                    let hi = if window.rounds.1 == u32::MAX { SEG_ALL } else { window.rounds.1 };
                    crate::vello::frame_log::note_window();
                    crate::vello::sink::note_passes(2);
                    backend.phased_fine(device, queue, &mut enc, window.rounds.0, hi, mode, None, None, &store_w);
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
                    self.present_final(&mut enc, device, &sw_view, &store_l0, width, height, wgpu::TextureFormat::Rgba8Unorm, sz, store_sz, full_view);
                }
            }
        }
        if in_session {
            backend.phased_finish(device, queue, &mut enc);
        }
        let t_end = crate::vello::prof::now();
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

        if let Some(t) = self.gpu_timer.as_mut() {
            t.end(&mut enc, &sw_view);
            t.resolve(&mut enc);
        }
        crate::vello::prof::inc_submit();
        queue.submit([enc.finish()]);
        backend.after_submit();
        if let Some(t) = self.gpu_timer.as_mut() {
            t.after_submit();
        }
        crate::vello::frame_log::end();
        self.frame_transient.push(store_tex);
        backend.set_frame_extent(0, 0);
    }

    /// Encode a `Frontend`'s draw commands into `scene`: body runs through the backend's whole-tree
    /// walk, coverages as white silhouettes, markers as `CMD_EFFECT` boundaries — and bake every
    /// distance item straight into its store rect (it is not a vello draw).
    fn encode_draws<B: RasterBackend>(
        &mut self,
        scene: &mut B::Scene,
        draws: &[DrawCmd],
        backend: &mut B,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        store_tex: &wgpu::Texture,
    ) -> usize {
        let root_index: HashMap<u128, usize> = crate::vello::abi::with_scene(|live, _, _| {
            live.roots().iter().enumerate().map(|(i, &id)| (id, i)).collect()
        });
        let mut baked = 0usize;
        for cmd in draws {
            match cmd {
                DrawCmd::Shapes { items, transform, clip } => {
                    if let Some(c) = clip {
                        scene.set_transform(Affine::IDENTITY);
                        scene.push_clip_layer(&c.to_path(0.1));
                    }
                    let mut i = 0;
                    while i < items.len() {
                        let it = &items[i];
                        match it.style {
                            DrawStyle::Body => {
                                let start = *root_index.get(&it.shape).unwrap_or_else(|| panic!("draw item {:x} is not a root", it.shape));
                                let mut end = start + 1;
                                i += 1;
                                while i < items.len()
                                    && items[i].style == DrawStyle::Body
                                    && root_index.get(&items[i].shape) == Some(&end)
                                {
                                    end += 1;
                                    i += 1;
                                }
                                backend.draw_scene_range(scene, *transform, start, end);
                            }
                            DrawStyle::Coverage { spread, .. } => {
                                backend.draw_coverage(scene, *transform, it.shape, spread);
                                i += 1;
                            }
                            DrawStyle::Distance { decode } => {
                                self.bake_distance(device, enc, store_tex, it.shape, *transform, it.bounds, decode, backend);
                                baked += 1;
                                i += 1;
                            }
                        }
                    }
                    if clip.is_some() {
                        scene.pop_layer();
                    }
                }
                DrawCmd::Marker { shape, transform, eid, seg_after, round, footprint, ctl, params_off } => {
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
                }
            }
        }
        baked
    }

    /// Bake `shape`'s outline distance into the store rect its item's bounds land on under
    /// `transform`. The rect must sit inside one store layer.
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
        let r = texels(bounds.with_origin(transform * bounds.origin()));
        let layer = r[1] / LAYER_PX;
        assert_eq!((r[3] - 1) / LAYER_PX, layer, "a distance rect sits inside one store layer");
        let view = store_tex.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_array_layer: layer,
            array_layer_count: Some(1),
            ..Default::default()
        });
        let segments: Vec<[f32; 4]> = segments
            .iter()
            .map(|s| [s[0], s[1] - (layer * LAYER_PX) as f32, s[2], s[3] - (layer * LAYER_PX) as f32])
            .collect();
        backend.phase_flush(enc);
        if self.sdf_baker.is_none() {
            self.sdf_baker = Some(crate::vello::sdf::SdfBaker::new(device));
        }
        let baker = self.sdf_baker.as_ref().expect("sdf baker built");
        baker.bake_into(device, enc, &view, &segments, (r[0], r[1] - layer * LAYER_PX, r[2] - r[0], r[3] - r[1]), decode, false);
        self.frame_transient_views.push(view);
    }
}
