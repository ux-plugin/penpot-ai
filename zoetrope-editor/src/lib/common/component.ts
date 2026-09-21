/**
 * Component library records — the document-level list of components plus the
 * declared property surface each one exposes to its copies.
 *
 * Note what is *not* here: any local shape type. Unlike slots, component copies
 * need no extension of the node union, because every field the model uses is
 * already on the upstream shape attributes — `shapeRef` on
 * `ShapeBaseAttributes`, and `componentId` / `componentFile` / `componentRoot` /
 * `mainInstance` / `remoteSynced` / `touched` on `ShapeAttributes`. A copy is an
 * ordinary frame wearing those fields, so selection, hit-test, layout and the
 * layers panel need to know nothing about components.
 *
 * Only the *library record* is local. Upstream's `ComponentRoot`
 * (`{ name, componentId, frameId }`) is a Figma-import artifact: it records which
 * Figma component a frame came from, and carries neither the page its main lives
 * on nor a declared property surface. See [[project_component_instance_model]].
 */
import type { Uuid } from 'penpot-exporter/types'
import type { PropId } from '../renderer/properties/registry'

/**
 * Kinds of declared property a component exposes. These map onto React props at
 * codegen, which is the reason the surface is declared at all rather than
 * inferred by diffing copies against their main.
 */
export type ComponentPropType = 'text' | 'boolean' | 'instance-swap' | 'variant'

/** One property, on one node of the main, that a prop drives. */
export interface ComponentPropTarget {
  /** Node id *within the main instance* — resolved per copy through `shapeRef`. */
  nodeId: Uuid
  /** A registered property id (`text.content`, `base.hidden`), see renderer/properties. */
  attr: PropId
}

export interface ComponentProp {
  id: string
  name: string
  type: ComponentPropType
  defaultValue: unknown
  targets: ComponentPropTarget[]
}

export interface LocalComponent {
  id: Uuid
  name: string
  path: string
  /** Root of the main instance — an ordinary frame living on a page, not a private copy. */
  mainInstanceId: Uuid
  mainInstancePage: Uuid
  props: ComponentProp[]
}

/**
 * Whether a library entry is one of ours and safe to act on.
 *
 * Imported documents may already carry entries in the same map, written by the
 * Figma adapter in the thinner upstream shape. Those have no main instance to
 * point at, so they are invisible to the component system rather than surfacing
 * as broken rows — which is what "leave imported instances alone" means in
 * practice.
 */
export function isUsableComponent(
  component: LocalComponent | null | undefined,
): component is LocalComponent {
  return (
    component != null &&
    typeof component.id === 'string' &&
    typeof component.mainInstanceId === 'string' &&
    typeof component.mainInstancePage === 'string'
  )
}
