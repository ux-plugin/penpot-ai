/**
 * Catalog registry — the open-union backing for trigger/action types.
 *
 * Trigger/Action `type` fields in the IR are open strings. This registry holds
 * the per-type metadata: the platforms it supports, an optional cross-platform
 * fallback, and (for actions) which normalized graph node-kind it lowers to.
 *
 * This is the mechanism that makes "foundation complete, catalog incremental"
 * real: adding `swipe` or `collection.move` is a `registerTriggers`/
 * `registerActions` call — never a change to the core IR types.
 */

import type { TriggerType, ActionType } from '../ir'

export type Platform = 'web' | 'native'

export interface TriggerCatalogEntry {
  key: TriggerType
  label: string
  /** node-attached vs app/page-level (locked app-rule scope, PHASE_0_PLAN §G1). */
  scope: 'node' | 'app'
  platforms: Platform[]
  /** Catalog key to fall back to when a platform is unsupported (e.g. hover -> press). */
  fallback?: TriggerType
  /** Expected param keys for `Trigger.params`. */
  params?: string[]
}

/** Which normalized graph node-kind an action lowers to. */
export type ActionLowering = 'fold' | 'effect' | 'switch' | 'setState'

export interface ActionCatalogEntry {
  key: ActionType
  label: string
  platforms: Platform[]
  fallback?: ActionType
  lowers: ActionLowering
  /** What `Action.target` must address, and whether `Action.value` is required. */
  expects: {
    target?: 'variable' | 'collection' | 'node.state' | 'screen' | 'overlay' | 'none'
    value?: boolean
  }
}

const triggers = new Map<TriggerType, TriggerCatalogEntry>()
const actions = new Map<ActionType, ActionCatalogEntry>()

export function registerTriggers(entries: TriggerCatalogEntry[]): void {
  for (const e of entries) triggers.set(e.key, e)
}

export function registerActions(entries: ActionCatalogEntry[]): void {
  for (const e of entries) actions.set(e.key, e)
}

export function getTrigger(key: TriggerType): TriggerCatalogEntry | undefined {
  return triggers.get(key)
}

export function getAction(key: ActionType): ActionCatalogEntry | undefined {
  return actions.get(key)
}

export function isKnownTrigger(key: TriggerType): boolean {
  return triggers.has(key)
}

export function isKnownAction(key: ActionType): boolean {
  return actions.has(key)
}

export function listTriggers(): TriggerCatalogEntry[] {
  return [...triggers.values()]
}

export function listActions(): ActionCatalogEntry[] {
  return [...actions.values()]
}

/**
 * Resolve a trigger for a target platform, applying the cross-platform fallback.
 * Returns undefined if neither the entry nor its fallback supports the platform.
 */
export function resolveTriggerForPlatform(
  key: TriggerType,
  platform: Platform
): TriggerCatalogEntry | undefined {
  const e = triggers.get(key)
  if (!e) return undefined
  if (e.platforms.includes(platform)) return e
  return e.fallback ? triggers.get(e.fallback) : undefined
}

/** Test helper: clear all registered entries. */
export function resetCatalog(): void {
  triggers.clear()
  actions.clear()
}
