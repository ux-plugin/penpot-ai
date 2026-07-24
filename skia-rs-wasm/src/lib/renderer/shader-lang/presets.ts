/**
 * Starter shader presets — "fork-me" SkSL templates shown in the preset gallery
 * when you start a new custom-shader material. Picking one seeds the editor with
 * working, editable source instead of a blank/default shader; the reuse taxonomy
 * (see [[project_shader_materials]]) is deliberate — presets are CODE TEMPLATES,
 * not tokens and not saved assets.
 *
 * Every preset is authored against the engine uniforms (`u_resolution`, and
 * `u_phase` for the animated ones — 0→1 over the loop, so the preview animates
 * and thumbnails can sample any frame). Keep them short and legible: they double
 * as the worked examples a first-time author learns the DSL from.
 */

import type { Material } from '../api/material'

export interface ShaderPreset {
  id: string
  name: string
  /** One-line description shown under the thumbnail. */
  description: string
  /** The phase (0→1) to freeze the thumbnail at — pick a visually representative frame. */
  thumbPhase: number
  material: Material
}

function sksl(source: string): Material {
  return { source, language: 'sksl', uniforms: [] }
}

export const SHADER_PRESETS: ShaderPreset[] = [
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Animated three-color gradient',
    thumbPhase: 0.25,
    material: sksl(`uniform float2 u_resolution;
uniform float u_phase;         // 0 -> 1 over one loop

const float TAU = 6.2831853;

half4 main(float2 p) {
  float2 uv = p / u_resolution;
  float t = 0.5 + 0.5 * sin(TAU * u_phase);
  half3 col = mix(half3(0.10, 0.30, 0.90), half3(0.90, 0.20, 0.60), uv.x);
  col = mix(col, half3(0.10, 0.90, 0.70), uv.y * t);
  return half4(col, 1.0);
}`),
  },
  {
    id: 'radial-pulse',
    name: 'Radial pulse',
    description: 'Concentric rings breathing outward',
    thumbPhase: 0.5,
    material: sksl(`uniform float2 u_resolution;
uniform float u_phase;

const float TAU = 6.2831853;

half4 main(float2 p) {
  float2 uv = p / u_resolution - 0.5;
  float d = length(uv);
  float rings = 0.5 + 0.5 * sin(d * 40.0 - TAU * u_phase);
  half3 col = mix(half3(0.05, 0.02, 0.15), half3(0.60, 0.40, 1.00), rings);
  return half4(col, 1.0);
}`),
  },
  {
    id: 'plasma',
    name: 'Plasma',
    description: 'Classic interfering sine field',
    thumbPhase: 0.2,
    material: sksl(`uniform float2 u_resolution;
uniform float u_phase;

const float TAU = 6.2831853;

half4 main(float2 p) {
  float2 uv = p / u_resolution * 6.0;
  float t = TAU * u_phase;
  float v = sin(uv.x + t) + sin(uv.y + t) + sin(uv.x + uv.y + t);
  v = 0.5 + 0.25 * v;
  half3 col = half3(
    0.5 + 0.5 * sin(TAU * v),
    0.5 + 0.5 * sin(TAU * v + 2.0),
    0.5 + 0.5 * sin(TAU * v + 4.0));
  return half4(col, 1.0);
}`),
  },
  {
    id: 'sweep',
    name: 'Sweep',
    description: 'Soft bars scrolling sideways',
    thumbPhase: 0.35,
    material: sksl(`uniform float2 u_resolution;
uniform float u_phase;

half4 main(float2 p) {
  float2 uv = p / u_resolution;
  float x = fract(uv.x * 5.0 - u_phase);
  float bar = smoothstep(0.0, 0.5, x) * smoothstep(1.0, 0.5, x);
  half3 col = mix(half3(0.05, 0.06, 0.10), half3(0.20, 0.80, 0.90), bar);
  return half4(col, 1.0);
}`),
  },
  {
    id: 'spotlight',
    name: 'Spotlight',
    description: 'A warm light orbiting the shape',
    thumbPhase: 0.15,
    material: sksl(`uniform float2 u_resolution;
uniform float u_phase;

const float TAU = 6.2831853;

half4 main(float2 p) {
  float2 uv = p / u_resolution;
  float2 c = float2(0.5 + 0.3 * sin(TAU * u_phase), 0.5 + 0.3 * cos(TAU * u_phase));
  float glow = smoothstep(0.5, 0.0, distance(uv, c));
  half3 col = mix(half3(0.02, 0.02, 0.05), half3(1.00, 0.85, 0.50), glow);
  return half4(col, 1.0);
}`),
  },
  {
    id: 'checker',
    name: 'Checker',
    description: 'A static two-tone grid (no clock)',
    thumbPhase: 0,
    material: sksl(`uniform float2 u_resolution;

half4 main(float2 p) {
  float2 g = floor(p / u_resolution * 8.0);
  float c = mod(g.x + g.y, 2.0);
  half3 col = mix(half3(0.12), half3(0.90), c);
  return half4(col, 1.0);
}`),
  },
]
