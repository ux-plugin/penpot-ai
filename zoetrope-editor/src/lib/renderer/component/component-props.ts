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
 * Those derived writes are deliberately NOT flagged `ignoreTouched`, so the
 * commit pipeline marks them as overrides. That is what protects a prop-driven
 * value from being clobbered by the next edit to the main, and it makes "reset
 * overrides" clear prop values and freeform overrides together — one notion of
 * "put this instance back to the component's defaults".
 */
import { snapshot } from 'valtio'
import { docProxy, getActiveOrSinglePageId } from '../store/doc-proxy'
import { commitChanges } from '../store/commit'
import { newShapeId } from '../../common/shape-id'
import { subtreeWithRoot } from '../../common/subtree'
import { isComponentCopyRoot } from '../../worker/geometry/shapes'
import { getComponent } from './component-crud'
import type { ComponentProp, ComponentPropType, LocalComponent } from '../../common/component'
import type { IndexedShape } from '../../worker/types'
import type { ModObjChange, PenpotNode, TextContent } from 'penpot-exporter/types'

function readObjects(pageId: string): Record<string, IndexedShape> | undefined {
  return snapshot(docProxy).pageMap.get(pageId)?.objects as
    | Record<string, IndexedShape>
    | undefined
}

function modObj(pageId: string, id: string, assign: Record<string, unknown>): ModObjChange {
  return { type: 'mod-obj', id, pageId, operations: [{ type: 'assign', value: assign }] }
}

/** Replace a component record wholesale, with its previous form as the inverse. */
async function commitComponent(previous: LocalComponent, next: LocalComponent): Promise<void> {
  await commitChanges({
    redoChanges: [],
    docMetaRedoChanges: [{ type: 'mod-component', component: next }],
    docMetaUndoChanges: [{ type: 'mod-component', component: previous }],
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
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return {}
  const root = readObjects(pageId)?.[copyRootId] as { propValues?: Record<string, unknown> } | undefined
  return { ...(root?.propValues ?? {}) }
}

/**
 * The value a copy renders for each declared prop, defaults filled in. This is
 * what codegen emits.
 */
export function resolvePropValues(copyRootId: string): Record<string, unknown> {
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return {}
  const objects = readObjects(pageId)
  const root = objects?.[copyRootId] as PenpotNode | undefined
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

/**
 * Rewrite a text node's content to a plain string, keeping the first run's
 * styling.
 *
 * A text prop makes its target a single-run label — extra runs and paragraphs
 * are dropped rather than preserved with stale text. That is the honest reading
 * of "this node's text is a parameter": if it needs rich internal structure, it
 * is not a parameter.
 */
function setPlainTextContent(content: TextContent | undefined, value: string): TextContent {
  const asRecord = content as unknown as Record<string, unknown> | undefined
  const paragraphSet = (asRecord?.children as Array<Record<string, unknown>> | undefined)?.[0]
  const paragraph = (paragraphSet?.children as Array<Record<string, unknown>> | undefined)?.[0]
  const firstRun = (paragraph?.children as Array<Record<string, unknown>> | undefined)?.[0]

  return {
    ...(asRecord ?? { type: 'root', verticalAlign: 'top' }),
    type: 'root',
    children: [
      {
        ...(paragraphSet ?? {}),
        type: 'paragraph-set',
        children: [
          {
            ...(paragraph ?? {}),
            type: 'paragraph',
            children: [{ ...(firstRun ?? {}), type: 'text', text: value }],
          },
        ],
      },
    ],
  } as unknown as TextContent
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
  const pageId = getActiveOrSinglePageId()
  if (!pageId) return false
  const objects = readObjects(pageId)
  if (!objects) return false
  const root = objects[copyRootId] as PenpotNode | undefined
  if (!isComponentCopyRoot(root) || !root?.componentId) return false
  const component = getComponent(root.componentId)
  const prop = component?.props.find((p) => p.id === propId)
  if (!prop) return false

  // Targets name nodes in the *main*; find their twins inside this copy.
  const byRef = new Map<string, string>()
  for (const id of subtreeWithRoot(objects, copyRootId)) {
    const ref = (objects[id] as { shapeRef?: string } | undefined)?.shapeRef
    if (ref != null) byRef.set(ref, id)
  }

  const redo: ModObjChange[] = []
  const undo: ModObjChange[] = []
  for (const target of prop.targets) {
    const localId = byRef.get(target.nodeId)
    if (!localId) continue
    const node = objects[localId] as PenpotNode | undefined
    if (!node) continue
    const write = propWrite(prop, value, node)
    if (!write) return false
    const before: Record<string, unknown> = {}
    for (const key of Object.keys(write)) {
      before[key] = (node as unknown as Record<string, unknown>)[key]
    }
    redo.push(modObj(pageId, localId, write))
    undo.unshift(modObj(pageId, localId, before))
  }

  const values = { ...((root as { propValues?: Record<string, unknown> }).propValues ?? {}) }
  const previousValues = { ...values }
  values[propId] = value
  redo.push(modObj(pageId, copyRootId, { propValues: values }))
  undo.unshift(modObj(pageId, copyRootId, { propValues: previousValues }))

  await commitChanges({ pageId, redoChanges: redo, undoChanges: undo })
  return true
}
