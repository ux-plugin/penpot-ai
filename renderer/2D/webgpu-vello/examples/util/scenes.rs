//! The battery: every named scene the effect harnesses install, one loader behind one name, so
//! the pixel battery and the graph fixtures agree on what a scene is. Returns the scene's cell
//! count (its canvas is [`render_core::parity::canvas_size`] of that).

/// Every battery scene name, in the order the fixtures list them.
#[allow(dead_code)]
pub const BATTERY: &[&str] = &[
    "backdrop-tint", "blur-grid", "boolean", "combined", "drop-grid", "dropblur-diag", "field-shade",
    "glass-grid-k", "glass-grid", "inner-grid", "inner-shadow", "layer-blur", "matrix", "mixed-grid",
    "multi-shadow", "parity", "path-shadow", "scope", "sharp-drop", "showcase", "stack-glass", "stress",
    "texture", "vpblur",
];

pub fn install(scene: &str) -> u32 {
    match scene {
        "scale" => render_core::vello::abi::load_scale_scene_sized(
            std::env::var("SHAPES").ok().and_then(|v| v.parse().ok()).unwrap_or(90),
            std::env::var("EVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(40),
            std::env::var("STEP").ok().and_then(|v| v.parse().ok()).unwrap_or(26.0),
            std::env::var("SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.9),
            std::env::var("OPEVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(7),
        ),
        "path-shadow" => render_core::vello::abi::load_path_shadow_scene(),
        "inner-shadow" => render_core::vello::abi::load_inner_shadow_scene(),
        "sharp-drop" => render_core::vello::abi::load_sharp_drop_scene(),
        "dropblur-diag" => render_core::vello::abi::load_dropblur_diag_scene(),
        "multi-shadow" => render_core::vello::abi::load_multi_shadow_scene(),
        "combined" => render_core::vello::abi::load_combined_scene(),
        "boolean" => render_core::vello::abi::load_boolean_scene(),
        "matrix" => render_core::vello::abi::load_matrix_scene(),
        "parity" => render_core::vello::abi::load_parity_scene(),
        "glass-grid" => render_core::vello::abi::load_glass_grid_scene(
            std::env::var("GLASS_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            u32::from(!std::env::var("GLASS_SHARP").is_ok()),
        ),
        "glass-grid-k" => render_core::vello::abi::load_glass_grid_scene_k(
            std::env::var("GLASS_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            u32::from(!std::env::var("GLASS_SHARP").is_ok()),
            std::env::var("GLASS_K_MILLI").ok().and_then(|v| v.parse().ok()).unwrap_or(500),
        ),
        "blur-grid" => render_core::vello::abi::load_blur_grid_scene(
            std::env::var("BLUR_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            std::env::var("BLUR_R").ok().and_then(|v| v.parse().ok()).unwrap_or(24),
        ),
        "drop-grid" => render_core::vello::abi::load_drop_grid_scene(
            std::env::var("DROP_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            std::env::var("DROP_R").ok().and_then(|v| v.parse().ok()).unwrap_or(10),
        ),
        "inner-grid" => render_core::vello::abi::load_inner_grid_scene(
            std::env::var("DROP_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            std::env::var("DROP_R").ok().and_then(|v| v.parse().ok()).unwrap_or(10),
        ),
        "mixed-grid" => render_core::vello::abi::load_mixed_grid_scene(
            std::env::var("DROP_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
        ),
        "stack-glass" => render_core::vello::abi::load_stack_glass_scene(
            std::env::var("GLASS_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            u32::from(std::env::var("GLASS_FROST").is_ok()),
        ),
        "backdrop-tint" => render_core::vello::abi::load_backdrop_tint_grid_scene(
            std::env::var("TINT_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
        ),
        "field-shade" => render_core::vello::abi::load_field_shade_grid_scene(
            std::env::var("TINT_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
        ),
        "vpblur" => render_core::vello::abi::load_vpblur_scene(
            std::env::var("BLUR_N").ok().and_then(|v| v.parse().ok()).unwrap_or(16),
            std::env::var("BLUR_R").ok().and_then(|v| v.parse().ok()).unwrap_or(8.0),
        ),
        "scope" => render_core::vello::abi::load_scope_scene(),
        "texture" => render_core::vello::abi::load_texture_scene(),
        "stress" => render_core::vello::abi::load_stress_scene_mask(
            std::env::var("STRESS_N").ok().and_then(|v| v.parse().ok()).unwrap_or(6),
            render_core::parity::FX_ALL,
        ),
        "showcase" => render_core::vello::abi::load_showcase_scene(),
        _ => render_core::vello::abi::load_layer_blur_scene(),
    }
}
