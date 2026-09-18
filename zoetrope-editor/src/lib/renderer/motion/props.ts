/**
 * The render-facing property vocabulary. These are the scalar transform/opacity
 * channels the modifier adapter (./modifier) knows how to compose into a matrix;
 * the animation IR (../anim) keeps property names as free strings, and this is
 * where the editor narrows them to what the Skia modifier path supports.
 */

/** Scalar properties the modifier adapter can apply. Position is split x/y so every channel is one number. */
export type AnimatableProperty = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity'

/** Interpolated property values at one instant — the render adapter's per-shape input. */
export type SampledProperties = Partial<Record<AnimatableProperty, number>>
