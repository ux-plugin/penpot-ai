/**
 * Mirror of the Rust preset table in
 * `render-wasm/src/test_fixtures.rs`. The id is the contract — match
 * exactly. Append-only; never reorder.
 */
export interface SceneEntry {
  id: number
  name: string
}

export const SCENES: readonly SceneEntry[] = [
  { id: 0, name: 'flat_baseline' },
  { id: 1, name: 'flat_1shadow' },
  { id: 2, name: 'flat_6shadows' },
  { id: 3, name: 'nested_d3_b5_no_fx' },
  { id: 4, name: 'nested_d3_b5_1shadow' },
  { id: 5, name: 'nested_d3_b5_6shadows' },
  { id: 6, name: 'mixed_kitchen_sink' },
  { id: 7, name: 'nested_d5_b5_3shadows_10k' },
  { id: 8, name: 'fast_mixed_500' },
  { id: 9, name: 'fx_combos_500' },
  // Per-effect isolation scenes — frame timings attribute to a single
  // effect path. Used to compare e.g. drop_shadow ms/frame vs glass
  // ms/frame on equal shape counts.
  { id: 10, name: 'iso_drop_shadow_200' },
  { id: 11, name: 'iso_inner_shadow_200' },
  { id: 12, name: 'iso_layer_blur_200' },
  { id: 13, name: 'iso_bg_blur_100' },
  { id: 14, name: 'iso_glass_100' },
  { id: 15, name: 'iso_texture_200' },
  { id: 16, name: 'iso_gradient_500' },
  { id: 17, name: 'iso_stroke_500' },
  { id: 18, name: 'iso_opacity_500' },
  { id: 19, name: 'iso_text_200' },
  { id: 20, name: 'iso_svg_50' },
  { id: 21, name: 'iso_masked_50' },
  { id: 22, name: 'iso_groups_100' },
  // Bespoke scene used by `test/visual/cache-capture.spec.ts` —
  // 1 root Frame containing 3 child Frames that overlap in tile (0,0);
  // topmost-z child has a GlassEffect. Reproduces the glass/scope bug.
  { id: 23, name: 'iso_glass_3frames_overlap' },
  // Minimal repro of "black glass child of frame": one parent frame
  // with fill, one glass-only child frame, no siblings. The glass
  // should refract the parent's fill — turns black when the inline
  // glass path can't reach the ancestor through Current/scope.
  { id: 24, name: 'iso_glass_solo_child' },
  // ── SSA Bucket A: gap-fill scenes for the IR rewrite ──────────
  // Scoped frame partially clipped by viewbox — exercises
  // world_bbox-clipping in handle_push_scope and the scoped backdrop
  // builder.
  { id: 25, name: 'iso_offscreen_scope' },
  // Nested scopes (F1 contains F2 contains glass), both scoped
  // because each has a gather descendant. Exercises the
  // enclosing-scopes loop in build_gather_backdrop_scoped.
  { id: 26, name: 'iso_nested_scopes_2deep_gathers' },
  // Two glass shapes z-stacked so the upper samples the lower's
  // gather output — forces a serial dep edge in the topo sort.
  { id: 27, name: 'iso_z_stacked_gathers' },
  // Two glass shapes far apart (different tile columns) — sample
  // neighborhoods don't share tiles, schedule can pipeline both.
  { id: 28, name: 'iso_sibling_gathers_disjoint' },
  // Two glass shapes adjacent with high blur — bboxes don't overlap
  // but sample neighborhoods do. Snapshot dedup is the win here.
  { id: 29, name: 'iso_sibling_gathers_overlapping' },
] as const
