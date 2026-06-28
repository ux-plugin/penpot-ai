/**
 * Motion data model — keyframe clips and named states.
 *
 * A clip animates one shape's scalar properties over time; a state is a single
 * named pose used by transition ("smart animate") blends. Both feed the same
 * sampler, so timeline playback and state transitions share one interpolation
 * path. See ./sampler.
 */

/**
 * Scalar properties a track can animate. Position is split into x/y so every
 * track interpolates a single number; vec2/colour tracks come later.
 */
export type AnimatableProperty = 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'opacity'

/**
 * Easing applied over the segment that STARTS at a keyframe — either a named
 * preset or explicit cubic-bézier control points [x1, y1, x2, y2] (the same
 * shape CSS `cubic-bezier()` uses).
 */
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | readonly [number, number, number, number]

export interface Keyframe {
  /** Milliseconds from the clip start. */
  time: number
  value: number
  /** Easing into the next keyframe. Defaults to 'linear' when omitted. */
  easing?: Easing
}

export interface PropertyTrack {
  property: AnimatableProperty
  /**
   * Keyframes ascending by time. The sampler assumes ordered input; authoring
   * code is responsible for keeping them sorted.
   */
  keyframes: Keyframe[]
}

export interface Clip {
  id: string
  /** Shape this clip drives. */
  targetId: string
  /** Total clip length in milliseconds. */
  duration: number
  tracks: PropertyTrack[]
  /** When true, time wraps modulo `duration` instead of clamping at the end. */
  loop?: boolean
}

/** Interpolated property values at one instant — the sampler's output per shape. */
export type SampledProperties = Partial<Record<AnimatableProperty, number>>

/** A named pose: a full set of property values. Transitions blend between two. */
export interface MotionState {
  id: string
  props: SampledProperties
}
