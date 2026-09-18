/**
 * Which shape attributes participate in component sync, and the group each one
 * belongs to.
 *
 * Ported from upstream Penpot's `sync-attrs`
 * ([component.cljc:47](common/src/app/common/types/component.cljc:47)), with the
 * kebab-case keywords rewritten as the camelCase field names our nodes use.
 *
 * Groups are the unit of local override. When the user edits an attribute on a
 * node inside a copy, that attribute's *whole group* is marked `touched` on that
 * node, and sync then leaves every attribute in the group alone for that node.
 * The coarseness is deliberate upstream and inherited here: without a declared
 * property surface there is no way to know which neighbouring attributes the
 * user meant to keep, so a conservative bucket is frozen around the edit. Our
 * declared props (P5) are the escape from that, not a replacement for it.
 *
 * A few attributes are ours rather than upstream's — noise, glass, texture and
 * material are local visual features — so they get local groups. `touched` is
 * declared upstream as `SyncGroups[]`; writing a local group is a documented
 * widening at the P4 write boundary, and is invisible in the persisted form
 * (both are plain strings).
 */
import type { SyncGroups } from 'penpot-exporter/types'

/** Upstream sync groups plus the ones covering our own visual features. */
export type ComponentSyncGroup =
  | SyncGroups
  | 'noise-group'
  | 'glass-group'
  | 'texture-group'
  | 'material-group'

/**
 * A group, or a per-shape-type map of groups. `content` is the reason the second
 * form exists: it means path geometry on a path and text on a text shape, and
 * the two must not freeze each other.
 */
type GroupSpec = ComponentSyncGroup | Record<string, ComponentSyncGroup>

const SYNC_ATTRS: Record<string, GroupSpec> = {
  name: 'name-group',

  fills: 'fill-group',
  fillColor: 'fill-group',
  fillOpacity: 'fill-group',
  hideFillOnExport: 'fill-group',

  content: { path: 'geometry-group', text: 'content-group' },
  positionData: 'content-group',
  boolType: 'content-group',
  boolContent: 'content-group',

  hidden: 'visibility-group',
  blocked: 'modifiable-group',

  growType: 'text-font-group',
  fontFamily: 'text-font-group',
  fontSize: 'text-font-group',
  fontStyle: 'text-font-group',
  fontWeight: 'text-font-group',

  letterSpacing: 'text-display-group',
  lineHeight: 'text-display-group',
  textAlign: 'text-display-group',

  strokes: 'stroke-group',
  strokeWidth: 'stroke-group',

  r1: 'radius-group',
  r2: 'radius-group',
  r3: 'radius-group',
  r4: 'radius-group',

  type: 'geometry-group',
  selrect: 'geometry-group',
  points: 'geometry-group',
  locked: 'geometry-group',
  proportion: 'geometry-group',
  proportionLock: 'geometry-group',
  x: 'geometry-group',
  y: 'geometry-group',
  width: 'geometry-group',
  height: 'geometry-group',
  rotation: 'geometry-group',
  transform: 'geometry-group',
  transformInverse: 'geometry-group',

  opacity: 'layer-effects-group',
  blendMode: 'layer-effects-group',
  shadow: 'shadow-group',
  blur: 'blur-group',
  backgroundBlur: 'blur-group',
  maskedGroup: 'mask-group',

  constraintsH: 'constraints-group',
  constraintsV: 'constraints-group',
  fixedScroll: 'constraints-group',

  exports: 'exports-group',
  grids: 'grids-group',
  showContent: 'show-content',

  layout: 'layout-container',
  layoutAlignContent: 'layout-align-content',
  layoutAlignItems: 'layout-align-items',
  layoutFlexDir: 'layout-flex-dir',
  layoutGap: 'layout-gap',
  layoutGapType: 'layout-gap',
  layoutJustifyContent: 'layout-justify-content',
  layoutJustifyItems: 'layout-justify-items',
  layoutWrapType: 'layout-wrap-type',
  layoutPadding: 'layout-padding',
  layoutPaddingType: 'layout-padding',
  layoutGridDir: 'layout-grid-dir',
  layoutGridRows: 'layout-grid-rows',
  layoutGridColumns: 'layout-grid-columns',
  layoutGridCells: 'layout-grid-cells',
  layoutItemMargin: 'layout-item-margin',
  layoutItemMarginType: 'layout-item-margin',
  layoutItemHSizing: 'layout-item-h-sizing',
  layoutItemVSizing: 'layout-item-v-sizing',
  layoutItemMaxH: 'layout-item-max-h',
  layoutItemMinH: 'layout-item-min-h',
  layoutItemMaxW: 'layout-item-max-w',
  layoutItemMinW: 'layout-item-min-w',
  layoutItemAbsolute: 'layout-item-absolute',
  layoutItemZIndex: 'layout-item-z-index',
  layoutItemAlignSelf: 'layout-item-align-self',

  // Local visual features, absent upstream.
  noise: 'noise-group',
  glass: 'glass-group',
  texture: 'texture-group',
  material: 'material-group',
}

/**
 * The group an attribute belongs to for a shape of `type`, or null when the
 * attribute takes no part in sync (ids, parenting, component bookkeeping…).
 */
export function resolveSyncGroup(
  shapeType: string | undefined,
  attr: string,
): ComponentSyncGroup | null {
  const spec = SYNC_ATTRS[attr]
  if (spec == null) return null
  if (typeof spec === 'string') return spec
  if (shapeType == null) return null
  return spec[shapeType] ?? null
}

/** Whether an attribute takes part in sync at all, for any shape type. */
export function isSyncAttr(attr: string): boolean {
  return SYNC_ATTRS[attr] != null
}

/**
 * Every attribute belonging to one of `groups`, for a shape of `type`.
 *
 * The reverse of {@link resolveSyncGroup}, and the reason resetting an override
 * can be surgical: clearing a node's `fill-group` re-pulls exactly the fill
 * attributes from the main and leaves everything else as it is.
 */
export function attrsInGroups(
  shapeType: string | undefined,
  groups: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  for (const attr of Object.keys(SYNC_ATTRS)) {
    const group = resolveSyncGroup(shapeType, attr)
    if (group != null && groups.has(group)) out.push(attr)
  }
  return out
}

/**
 * Token bindings (`node.appliedTokens[prop] = tokenName`) sync per key, not as a
 * whole map, so each binding gets a group of its own.
 *
 * Upstream reaches the same conclusion by a different route: `:applied-tokens` is
 * excluded from `sync-attrs` and given a dedicated path that diffs the two token
 * maps key by key ([libraries.cljc:1614](common/src/app/common/logic/libraries.cljc:1614)).
 * Modelling each key as its own group gets that granularity while reusing the
 * `touched` machinery unchanged — overriding a copy's `fill` token leaves its
 * `strokeColor` token still tracking the main.
 *
 * These are synthetic: `resolveSyncGroup` never returns one, because the group
 * depends on the key rather than the attribute name.
 */
export const APPLIED_TOKENS_ATTR = 'appliedTokens'
const APPLIED_TOKEN_GROUP_PREFIX = 'applied-token/'

export function appliedTokenGroup(tokenProp: string): string {
  return `${APPLIED_TOKEN_GROUP_PREFIX}${tokenProp}`
}

/** The token property a synthetic group refers to, or null for an ordinary group. */
export function appliedTokenProp(group: string): string | null {
  return group.startsWith(APPLIED_TOKEN_GROUP_PREFIX)
    ? group.slice(APPLIED_TOKEN_GROUP_PREFIX.length)
    : null
}

/** Token-map keys whose binding differs between two maps, additions and removals included. */
export function changedTokenProps(
  before: Record<string, string> | undefined,
  after: Record<string, string> | undefined,
): string[] {
  const a = before ?? {}
  const b = after ?? {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return Array.from(keys).filter((key) => a[key] !== b[key])
}

/**
 * Geometry is not synced yet.
 *
 * Copies sit at their own positions, so a main's geometry cannot be copied
 * across verbatim — it has to be rebased by each copy's offset from the main,
 * and for descendants that interacts with rotation, constraints and layout.
 * That work belongs with structural sync (P6), where child add/remove/reorder is
 * handled in the same pass. Until then appearance syncs and geometry does not,
 * which is a defined behaviour with a test on it rather than an accident.
 */
export const UNSYNCED_GROUPS: ReadonlySet<ComponentSyncGroup> = new Set(['geometry-group'])
