/**
 * The unified animation IR -- ground floor.
 *
 * This is the Rive-model base of the model described in docs/animation-model.md:
 * a scene-graph-referencing animation layer whose atom is a `Binding` (a property
 * driven by a `Curve`). The load-bearing unification is `Domain`: a keyframe
 * track and a parameter binding are the SAME structure -- a curve sampled over a
 * domain (time, or a named parameter). Rig (bones/skin) and logic (state machine)
 * are typed here so the base model is whole; their evaluators land in later
 * slices. INP blendshape deformers and Lottie generators/effects attach as
 * additional layers on top of this without disturbing the core.
 *
 * Distinct from the shipped `../motion` slice (a narrower time-only delta model);
 * that will later re-express onto this IR. See ./sample for the evaluator.
 */

/**
 * Interpolation from a key into the next one. A named preset, an explicit
 * cubic-bezier `[x1, y1, x2, y2]` (the CSS `cubic-bezier()` shape), or `hold`
 * (step -- keep the value until the next key).
 */
export type Interp =
  | 'hold'
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | readonly [number, number, number, number]

/** One sample point on a curve: a scalar `value` at domain position `at`. */
export interface Key {
  /** Position along the curve's domain (ms for time, or a raw param value). */
  at: number
  value: number
  /** Easing into the next key. Defaults to 'linear'. */
  interp?: Interp
}

/**
 * The domain a curve is sampled over -- THE unification. `time` makes the curve a
 * classic keyframe track; `param` makes it a parameter binding (Rive input / INP
 * parameter). Same math, different independent variable.
 */
export type Domain = { kind: 'time' } | { kind: 'param'; param: string }

/** A scalar function of its domain, defined by keys ascending in `at`. */
export interface Curve {
  domain: Domain
  keys: Key[]
}

/**
 * A named input / parameter: a Rive input or an INP parameter. Feeds
 * param-domain curves and state-machine conditions. `trigger` is a one-shot
 * pulse; `bool`/`number` hold a value.
 */
export interface Param {
  id: string
  kind: 'number' | 'bool' | 'trigger'
  value?: number
  min?: number
  max?: number
}

/** Which object a binding drives. Node = a scene-graph node in our document. */
export type ObjectRef =
  | { kind: 'node'; id: string }
  | { kind: 'bone'; id: string }
  | { kind: 'param'; id: string } // driving a param = driver composition (e.g. time-remap)

/** A concrete animatable target: an object plus a property path (`x`, `rotation`, `opacity`, ...). */
export interface Target {
  object: ObjectRef
  prop: string
}

/** The atom of animation: a property driven by a curve. */
export interface Binding {
  target: Target
  curve: Curve
}

/** A named animation: a bundle of bindings evaluated together over one clock. */
export interface Timeline {
  id: string
  /** Length in ms (max key `at` across time-domain bindings). */
  duration: number
  loop?: boolean
  bindings: Binding[]
}

// --- Rig (typed now; evaluated in a later slice) ---

export interface Bone {
  id: string
  parent?: string
  /** Rest length; local transform is driven via bindings on this bone. */
  length: number
}

export interface VertexWeight {
  vertex: number
  bones: { bone: string; weight: number }[]
}

export interface Skin {
  /** Node id of the mesh this skin deforms. */
  mesh: string
  weights: VertexWeight[]
}

// --- State machine (typed now; evaluated in a later slice) ---

/** A 1D blend space: pick/mix timelines by an input value along `at` positions. */
export interface BlendState {
  input: string
  inputs: { at: number; timeline: string }[]
}

export interface SMState {
  id: string
  /** A single timeline, or a blend space -- exactly one. */
  timeline?: string
  blend?: BlendState
}

export interface SMCondition {
  param: string
  op: '>' | '<' | '==' | 'true' | 'false' | 'trigger'
  value?: number
}

export interface SMTransition {
  from: string
  to: string
  conditions: SMCondition[]
  /** Blend duration in ms. */
  duration: number
}

export interface SMLayer {
  states: SMState[]
  transitions: SMTransition[]
}

export interface StateMachine {
  id: string
  params: string[]
  layers: SMLayer[]
}

/**
 * The animation document -- layered OVER the scene graph (references nodes by
 * id; never owns geometry). Later layers (deformers, generators, effects) attach
 * as optional fields alongside these.
 */
export interface AnimDoc {
  params: Param[]
  timelines: Timeline[]
  bones?: Bone[]
  skins?: Skin[]
  stateMachines?: StateMachine[]
}
