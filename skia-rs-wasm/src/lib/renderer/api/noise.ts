/**
 * Noise effect transformer
 */

import type { WasmModule } from '../wasm-types'
import type { Noise } from '../properties/panel-utils'
import { colorToU32ARGB } from '../types'
import { translateNoiseType } from './serializers'
import { checkContext } from './context'

/**
 * Set the noise effect on the current shape.
 * Calls _clear_shape_noise when noise is null/undefined.
 */
export function setShapeNoise(module: WasmModule, noise: Noise | null | undefined): void {
  checkContext()
  if (noise) {
    module._set_shape_noise(
      translateNoiseType(noise.noiseType),
      noise.noiseSize ?? 50,
      noise.density ?? 0.5,
      colorToU32ARGB({
        color: noise.color?.color ?? '#000000',
        opacity: noise.color?.opacity ?? 1,
      }),
      colorToU32ARGB({
        color: noise.secondaryColor?.color ?? '#ffffff',
        opacity: noise.secondaryColor?.opacity ?? 1,
      }),
      noise.hidden ? 1 : 0,
    )
  } else {
    module._clear_shape_noise()
  }
}
