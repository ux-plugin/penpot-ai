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
] as const
