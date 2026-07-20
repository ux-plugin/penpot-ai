//! Isolated shader-material preview — a second GPU surface, bound to its own
//! WebGL context (the focus-mode preview canvas), that renders ONE material
//! standalone: no document, no neighbour shapes, no viewport zoom. That
//! isolation is the whole point — the on-canvas render is "in context" and
//! therefore noisy; this is the authoring view, where resolution and framing
//! are ours to choose.
//!
//! **Context discipline (important).** Skia's `Interface::new_native()` binds
//! whatever GL context is *currently current*, so the `GpuState` built here
//! belongs to whichever context was current at `try_new()`. The JS side owns
//! the context lifecycle (create → `GL.registerContext` → `GL.makeContextCurrent`,
//! mirroring `api/canvas.ts`) and MUST make the preview context current before
//! calling into any of these, then restore the main context afterwards.
//! Drawing with the wrong context current corrupts both.
//!
//! The shader itself is built by `render::ssa::material::make_material_shader`
//! — the exact same compile + uniform-bind path the on-canvas render uses — so
//! the preview cannot drift from the real render, and both share the
//! source-keyed `RuntimeEffect` cache.

use skia_safe as skia;

use crate::error::Result;
use crate::render::gpu_state::GpuState;
use crate::render::ssa::material::{make_material_shader, EngineUniforms};
use crate::shapes::Material;

pub struct PreviewState {
    gpu: GpuState,
    surface: skia::Surface,
    width: i32,
    height: i32,
    material: Option<Material>,
}

/// Leash the preview context's GPU resource cache. It only ever holds one
/// framebuffer-wrapping surface plus a compiled program or two, so it can't
/// legitimately need much — and a bound means a long-lived preview context
/// can't quietly accumulate VRAM across a session. Skia evicts under this
/// budget on its own; `purge`/`abandon` are the explicit releases.
const PREVIEW_RESOURCE_CACHE_BYTES: usize = 64 * 1024 * 1024;

impl PreviewState {
    /// Build the preview GPU state + a surface wrapping the preview canvas's
    /// default framebuffer. The preview GL context must be current.
    pub fn try_new(width: i32, height: i32) -> Result<Self> {
        let mut gpu = GpuState::try_new()?;
        gpu.context
            .set_resource_cache_limit(PREVIEW_RESOURCE_CACHE_BYTES);
        let surface = gpu.create_target_surface(width, height)?;
        Ok(Self {
            gpu,
            surface,
            width,
            height,
            material: None,
        })
    }

    /// Re-wrap the framebuffer at a new size. Cheap — the context and its
    /// caches (including compiled GL programs) survive.
    pub fn resize(&mut self, width: i32, height: i32) -> Result<()> {
        if width == self.width && height == self.height {
            return Ok(());
        }
        self.surface = self.gpu.create_target_surface(width, height)?;
        self.width = width;
        self.height = height;
        Ok(())
    }

    pub fn set_material(&mut self, material: Option<Material>) {
        self.material = material;
    }

    /// Draw the material over the whole preview surface. `fragCoord` spans
    /// `0..(w,h)` and `u_resolution` is the surface size, so a shader authored
    /// against `u_resolution` fills the pane exactly. `u_scale` is 1.0 — the
    /// preview has no viewport zoom; resolution is chosen by the caller.
    ///
    /// **Keep-last-good on compile error.** Every incomplete keystroke is a
    /// compile error, so clearing on failure would strobe the pane blank while
    /// you type. Instead a failed compile returns early leaving the surface
    /// untouched (the canvas is `preserveDrawingBuffer`), and the editor's
    /// status line carries the error. Only an absent/hidden material clears.
    pub fn draw(&mut self, time: f32, phase: f32) {
        // Build the shader first so the `&self.material` borrow ends before the
        // `&mut self.surface` / `&mut self.gpu` borrows below.
        let shader = match self.material.as_ref().filter(|m| !m.hidden) {
            // Nothing to show — fall through and clear.
            None => None,
            Some(m) => {
                let engine = EngineUniforms {
                    resolution: (self.width as f32, self.height as f32),
                    scale: 1.0,
                    time,
                    phase,
                };
                match make_material_shader(m, &engine, None) {
                    Some(shader) => Some(shader),
                    // Compile error — leave the last good frame on screen.
                    None => return,
                }
            }
        };

        let canvas = self.surface.canvas();
        canvas.clear(skia::Color::TRANSPARENT);
        if let Some(shader) = shader {
            let mut paint = skia::Paint::default();
            paint.set_anti_alias(true);
            paint.set_shader(shader);
            canvas.draw_paint(&paint);
        }
        self.gpu.context.flush_and_submit();
    }

    /// Release cached GPU resources while KEEPING the context alive — for when
    /// focus mode closes. Recreating the context would force a full shader
    /// re-compile on reopen (the GL program cache is per-context), so we keep
    /// it warm and just drop the VRAM.
    ///
    /// Issues GL calls, so the preview context must be current. For a context
    /// that's already GONE use `abandon` instead.
    pub fn purge(&mut self) {
        self.gpu.context.free_gpu_resources();
    }

    /// The backing GL context is GONE (`webglcontextlost`). Drop Skia's GPU
    /// resources **without issuing any GL calls** — the only safe move here.
    ///
    /// This must happen before the `PreviewState` is dropped: Skia's normal
    /// teardown (and `purge`/`free_gpu_resources`) frees resources by *calling*
    /// GL, which against a dead context is undefined — and worse, whatever
    /// context happens to be current would receive those calls, so a lost
    /// preview context could corrupt the MAIN canvas. `abandon` marks every
    /// resource invalid and suppresses the calls, making the subsequent drop
    /// inert. (Not `release_resources_and_abandon`, which *does* issue GL.)
    pub fn abandon(&mut self) {
        self.gpu.context.abandon();
    }
}
