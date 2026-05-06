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
] as const
