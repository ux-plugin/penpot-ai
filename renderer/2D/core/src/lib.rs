pub use kurbo;
pub use peniko;

pub mod abi;
pub mod atlas;
pub mod blend;
pub mod blur;
pub mod effect;
pub mod effect_graph;
pub mod field;
pub mod footprint;
pub mod geometry;
pub mod gradient;
pub mod host;
pub mod model;
pub mod parity;
pub mod quadtree;
pub mod schedule;
pub mod selection;
pub mod text;
#[cfg(feature = "tiled-scheduler")]
pub mod tile_cache;
pub mod tiling;

/// The backend-agnostic Vello layer (formerly the `render-vello-core` crate): the device-generic
/// wgpu effect executor — compositor/blit, glass pass-graph, blur, custom-WGSL pass runner — plus
/// the neutral drawer, the shared production sink, and the `#[unsafe(no_mangle)]` FFI shell both
/// backend cdylibs re-export. Nested here so it and the neutral core are one crate.
pub mod vello;
