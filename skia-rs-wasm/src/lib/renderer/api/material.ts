/**
 * Custom SkSL material (shader fill) operations.
 *
 * A material is a user-authored SkSL shader bound as a single shape's fill.
 * Its uniforms are reflected/bound by name on the Rust side, so the payload
 * just carries the source plus the current uniform values.
 *
 * Shared-memory layout matches `wasm/material.rs::parse_material` (little-endian):
 *   [u32 hidden]
 *   [u32 source_len] [source bytes] [pad → 4B]
 *   [u32 uniform_count]
 *   per uniform: [u32 name_len] [name bytes] [pad → 4B] [u32 comp] [comp × f32]
 * where `comp` (1..=4) is the component count → f32/vec2/vec3/vec4.
 */

import type { WasmModule } from '../wasm-types'
import { checkContext } from './context'
import { allocBytes, freeBytes } from '../utils'

export type MaterialUniformValue =
  | { type: 'f32'; value: number }
  | { type: 'vec2'; value: readonly [number, number] }
  | { type: 'vec3'; value: readonly [number, number, number] }
  | { type: 'vec4'; value: readonly [number, number, number, number] }

export interface MaterialUniform {
  name: string
  value: MaterialUniformValue
}

export interface Material {
  /** SkSL source, compiled to this shape's fill shader. */
  source: string
  /** Current uniform values, matched to the shader's uniforms by name. */
  uniforms?: MaterialUniform[]
  hidden?: boolean
}

/** A uniform reflected from compiled SkSL — drives which control the editor shows. */
export interface ReflectedUniform {
  name: string
  /** Component count 1..4; `0` for types with no simple control (matrices). */
  components: number
  /** True when declared `layout(color)` — render a color swatch, not sliders. */
  isColor: boolean
  /** Array length (1 when scalar). */
  count: number
}

/** Result of compiling a material's source: status + reflected uniforms/inputs. */
export interface MaterialCompileResult {
  ok: boolean
  /** Compile error message when `ok` is false. */
  error?: string
  uniforms: ReflectedUniform[]
  /** `uniform shader` input names (e.g. `content`/`backdrop`/`field`). */
  inputs: string[]
  /**
   * True when the source declares `u_time` — the material is clock-driven, so
   * the editor offers transport and runs an animation loop. `u_time` is
   * engine-owned and never appears in `uniforms`, so this is the only signal.
   */
  usesTime: boolean
}

const COMP_COUNT: Record<MaterialUniformValue['type'], number> = {
  f32: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
}

const align4 = (n: number): number => (n + 3) & ~3

/**
 * Stage a material into shared memory in the LE layout above. The caller then
 * invokes the matching wasm entry point and calls `freeBytes`.
 *
 * Shared by the on-canvas path (`_set_shape_material`) and the isolated focus
 * preview (`_preview_set_material`) so the layout is written in exactly one
 * place and the two can't drift.
 */
function stageMaterialPayload(module: WasmModule, material: Material): void {
  const enc = new TextEncoder()
  const source = enc.encode(material.source)
  const uniforms = material.uniforms ?? []
  const names = uniforms.map((u) => enc.encode(u.name))

  let size = 4 // hidden
  size += 4 + align4(source.length) // source_len + source + pad
  size += 4 // uniform_count
  for (let i = 0; i < uniforms.length; i++) {
    size += 4 + align4(names[i].length) // name_len + name + pad
    size += 4 + COMP_COUNT[uniforms[i].value.type] * 4 // comp + values
  }

  const offset = allocBytes(module, size)
  const heap = module.HEAPU8
  const dv = new DataView(heap.buffer, heap.byteOffset)
  let p = offset

  dv.setUint32(p, material.hidden ? 1 : 0, true)
  p += 4
  dv.setUint32(p, source.length, true)
  p += 4
  heap.set(source, p)
  p += align4(source.length)
  dv.setUint32(p, uniforms.length, true)
  p += 4

  for (let i = 0; i < uniforms.length; i++) {
    const name = names[i]
    dv.setUint32(p, name.length, true)
    p += 4
    heap.set(name, p)
    p += align4(name.length)

    const v = uniforms[i].value
    dv.setUint32(p, COMP_COUNT[v.type], true)
    p += 4
    if (v.type === 'f32') {
      dv.setFloat32(p, v.value, true)
      p += 4
    } else {
      for (let k = 0; k < v.value.length; k++) {
        dv.setFloat32(p, v.value[k], true)
        p += 4
      }
    }
  }
}

/**
 * Set the custom SkSL material on the current shape. Clears when `material`
 * is null/undefined or has no source.
 */
export function setShapeMaterial(module: WasmModule, material: Material | null | undefined): void {
  checkContext()
  if (!material || !material.source) {
    module._clear_shape_material()
    return
  }
  stageMaterialPayload(module, material)
  module._set_shape_material()
  freeBytes(module)
}

/**
 * Set the material rendered by the isolated focus preview. Same payload as
 * `setShapeMaterial`, different entry point — the preview keeps its own copy
 * and never touches the document's shape tree.
 *
 * Only stages + parses (no GL work), so it doesn't require the preview context
 * to be current — but `focus-preview.ts` calls it inside the same make-current
 * block as the draw anyway, which is harmless and keeps the sequence obvious.
 */
export function setPreviewMaterial(module: WasmModule, material: Material | null | undefined): void {
  if (typeof module._preview_set_material !== 'function') return
  if (!material || !material.source) {
    module._preview_clear_material()
    return
  }
  stageMaterialPayload(module, material)
  module._preview_set_material()
  freeBytes(module)
}

/**
 * Compile a material's SkSL source and reflect its editable uniforms + shader
 * inputs. Mirrors `wasm/material.rs::compile_material`'s result layout (LE):
 *   [u32 ok][u32 err_len][err bytes][u32 uniform_count]
 *   per uniform: [u32 name_len][name][u32 components][u32 is_color][u32 count]
 *   [u32 input_count] per input: [u32 name_len][name]
 *
 * The editor uses this to build controls and surface compile errors.
 */
export function compileMaterial(module: WasmModule, source: string): MaterialCompileResult {
  checkContext()

  // Guard against a stale binary that predates this export: calling a missing
  // function throws *after* we've staged the input buffer, leaking it and
  // cascading into a "Bytes already allocated" panic on the next alloc.
  if (typeof module._compile_material !== 'function') {
    return {
      ok: false,
      error: 'Renderer is out of date — rebuild the WASM (pnpm --filter skia-rs-wasm build:wasm).',
      uniforms: [],
      inputs: [],
      usesTime: false,
    }
  }

  const src = new TextEncoder().encode(source)
  const inOffset = allocBytes(module, Math.max(src.length, 1))
  try {
    module.HEAPU8.set(src, inOffset)

    const ptr = module._compile_material()

    // Re-read the heap after the call — wasm memory may have grown, invalidating
    // any earlier HEAPU8 view.
    const heap = module.HEAPU8
    const dv = new DataView(heap.buffer, heap.byteOffset)
    const dec = new TextDecoder()
    let p = ptr

    const readU32 = (): number => {
      const v = dv.getUint32(p, true)
      p += 4
      return v
    }
    const readStr = (): string => {
      const n = readU32()
      const s = dec.decode(heap.subarray(p, p + n))
      p += n
      return s
    }

    const ok = readU32() === 1
    const error = readStr()

    const uniformCount = readU32()
    const uniforms: ReflectedUniform[] = []
    for (let i = 0; i < uniformCount; i++) {
      const name = readStr()
      const components = readU32()
      const isColor = readU32() === 1
      const count = readU32()
      uniforms.push({ name, components, isColor, count })
    }

    const inputCount = readU32()
    const inputs: string[] = []
    for (let i = 0; i < inputCount; i++) {
      inputs.push(readStr())
    }
    const usesTime = readU32() === 1

    return {
      ok,
      error: error.length > 0 ? error : undefined,
      uniforms,
      inputs,
      usesTime,
    }
  } finally {
    // Always release the staged buffer — even if parsing throws — so a failure
    // can't leave BUFFERU8 allocated and panic the next alloc.
    freeBytes(module)
  }
}
