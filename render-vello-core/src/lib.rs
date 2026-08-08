//! Backend-agnostic Vello layer — the device-generic wgpu effect executor shared by the
//! vello_hybrid and classic-vello sinks.
//!
//! Nothing here touches a specific Vello renderer or the neutral-model ABI. It runs *our own* wgpu
//! pipelines — the SrcOver compositor and blit ([`blend`]), the frosted-glass pass-graph
//! ([`glass`]), the separable/pyramid Gaussian blur and the custom-WGSL pass runner ([`graph`]) —
//! against any `wgpu::Device`, driven by the render-core effect-graph IR
//! (`render_core::effect_graph`). [`prof`] is the per-phase sink profiler.
//!
//! This is Phase 1 of the classic-Vello third-backend carve: because these pipelines are generic
//! over the device (not the Vello flavor), both sinks reuse them unchanged — the classic backend
//! only has to supply its own scene rasterization, not re-implement effects.

pub mod blend;
pub mod draw;
pub mod glass;
pub mod graph;
pub mod prof;
pub mod rasterize;
pub mod text;
