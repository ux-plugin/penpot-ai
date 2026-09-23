/**
 * Declared component properties — the parameter surface a component exposes, and
 * the values each copy gives them.
 *
 * This is the layer that makes generated code readable. A freeform override
 * compiles to an inline style on one instance; a declared prop compiles to
 * `<Button label="Save" />`. The distinction is not about literal versus
 * variable — `label="Save"` is a literal and perfectly idiomatic — it is about
 * whether the variation is *named*. See [[project_component_instance_model]].
 *
 * Declaration lives on the component (`LocalComponent.props`, in the doc-meta
 * arm); values live on the copy root as `propValues: Record<propId, unknown>`.
 * Setting a value also writes the attribute it drives onto the target node,
 * because copies are materialized — the document always holds real values, and
 * nothing has to resolve props at paint time.
 *
 * Those derived writes are deliberately NOT `system`, so the commit pipeline
 * marks them as overrides. That is what protects a prop-driven
 * value from being clobbered by the next edit to the main, and it makes "reset
 * overrides" clear prop values and freeform overrides together — one notion of
 * "put this instance back to the component's defaults".
 */
import { commitChanges } from '../store/commit'
import { descendants, getNode, mod, type Change, type Node } from '../../doc'
import { newShapeId } from '../../common/shape-id'
import { isComponentCopyRoot } from '../../worker/geometry/shapes'
import { getComponent } from './component-crud'
import { setPlainTextContent } from '../../common/text-content'
import type { ComponentProp, ComponentPropType, LocalComponent } from '../../common/component'
import type { PenpotNode, TextContent } from 'penpot-exporter/types'

/** Replace a component record wholesale, with its previous form as the inverse. */
async function commitComponent(previous: LocalComponent, next: LocalComponent): Promise<void> {
  await commitChanges({
    docMeta: [{ type: 'mod-component', component: next }],
    docMetaUndo: [{ type: 'mod-component', component: previous }],
  })
}

// ── Declaration ──────────────────────────────────────────────────────────────

export interface NewComponentProp {
  name: string
  type: ComponentPropType
  defaultValue: unknown
  targets: ComponentProp['targets']
}

/** Declare a property on a component. Returns its id, or null if unknown component. */
export async function addProp(
  componentId: string,
  spec: NewComponentProp,
): Promise<string | null> {
  const component = getComponent(componentId)
  if (!component) return null
  const prop: ComponentProp = { id: newShapeId(), ...spec }
  await commitComponent(component, { ...component, props: [...component.props, prop] })
  return prop.id
}

/** Rename a property, change its default, or retarget it. */
export async function updateProp(
  componentId: string,
  propId: string,
  patch: Partial<Omit<ComponentProp, 'id'>>,
): Promise<boolean> {
  const component = getComponent(componentId)
  if (!component) return false
  if (!component.props.some((p) => p.id === propId)) return false
  const props = component.props.map((p) => (p.id === propId ? { ...p, ...patch } : p))
  await commitComponent(component, { ...component, props })
  return true
}

/**
 * Undeclare a property. Values already set on copies are left in place: they are
 * ordinary overrides on the target nodes now, which is what un-declaring means —
 * the variation stops being named, it does not get undone.
 */
export async function removeProp(componentId: string, propId: string): Promise<boolean> {
  const component = getComponent(componentId)
  if (!component) return false
  const props = component.props.filter((p) => p.id !== propId)
  if (props.length === component.props.length) return false
  await commitComponent(component, { ...component, props })
  return true
}

// ── Values ───────────────────────────────────────────────────────────────────

/** Prop values set on a copy. Absent keys mean the component's declared default. */
export function getPropValues(copyRootId: string): Record<string, unknown> {
  const root = getNode(copyRootId) as { propValues?: Record<string, unknown> } | undefined
  return { ...(root?.propValues ?? {}) }
}

/**
 * The value a copy renders for each declared prop, defaults filled in. This is
 * what codegen emits.
 */
export function resolvePropValues(copyRootId: string): Record<string, unknown> {
  const root = getNode(copyRootId)
  if (!root?.componentId) return {}
  const component = getComponent(root.componentId)
  if (!component) return {}
  const set = getPropValues(copyRootId)
  const out: Record<string, unknown> = {}
  for (const prop of component.props) {
    out[prop.name] = prop.id in set ? set[prop.id] : prop.defaultValue
  }
  return out
}


/** The attribute write a prop of this type implies on its target node. */
function propWrite(
  prop: ComponentProp,
  value: unknown,
  target: PenpotNode,
): Record<string, unknown> | null {
  switch (prop.type) {
    case 'text':
      return { content: setPlainTextContent(target.content as TextContent | undefined, String(value ?? '')) }
    case 'boolean':
      // Figma's sense: the prop says whether the node is shown.
      return { hidden: !value }
    case 'instance-swap':
    case 'variant':
      // Both need machinery that does not exist yet (swap, variants). Declaring
      // one is allowed so the surface can be designed; setting it is a no-op
      // rather than a silent wrong write.
      return null
    default:
      return null
  }
}

/**
 * Set a prop on one copy: records the value on the copy root and writes the
 * attributes it drives onto the target nodes inside that copy.
 *
 * One history frame. Returns false when the copy, component or prop is unknown,
 * or when the prop's type has no implementation yet.
 */
export async function setPropValue(
  copyRootId: string,
  propId: string,
  value: unknown,
): Promise<boolean> {
  const root = getNode(copyRootId)
  if (!isComponentCopyRoot(root) || !root?.componentId) return false
  const component = getComponent(root.componentId)
  const prop = component?.props.find((p) => p.id === propId)
  if (!prop) return false

  // Targets name nodes in the *main*; find their twins inside this copy.
  const byRef = new Map<string, string>()
  for (const id of [copyRootId, ...descendants(copyRootId)]) {
    const ref = getNode(id)?.shapeRef
    if (ref != null) byRef.set(ref, id)
  }

  const changes: Change[] = []
  for (const target of prop.targets) {
    const localId = byRef.get(target.nodeId)
    const node = getNode(localId)
    if (!node) continue
    const write = propWrite(prop, value, node)
    if (!write) return false
    changes.push(mod('node', localId!, write as Partial<Node>))
  }

  const values = { ...((root as { propValues?: Record<string, unknown> }).propValues ?? {}) }
  values[propId] = value
  changes.push(mod('node', copyRootId, { propValues: values } as Partial<Node>))

  await commitChanges({ changes })
  return true
}
