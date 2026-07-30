/**
 * Resolving and editing a shape's shader material now that materials are
 * document-level objects rather than a field on the node.
 *
 * A shape carries `materialId`; the material itself lives in
 * `docProxy.meta.materials`. Everything that used to read `node.material` reads
 * {@link materialOf} instead, and everything that used to write it goes through
 * {@link assignMaterial} / {@link updateMaterial} / {@link clearMaterial}.
 *
 * ## Assigning copies, it does not link
 *
 * {@link assignMaterial} mints a fresh id every time. Two shapes never end up
 * pointing at one material by accident, because a shared material means editing
 * a shader from inside one shape silently changes the others — and it makes the
 * version history ambiguous, since restoring from one shape's stage would move
 * every shape using it.
 *
 * Reuse is a separate feature when we want it, and copy-first does not block it:
 * a copy carrying no back-reference is exactly an unlinked instance, so adding
 * `materialRef` plus per-field `touched` later follows the model components
 * already use, with nothing to migrate.
 *
 * ## Why `shaded` exists
 *
 * Hit-testing runs in the worker, which applies raw `Change`s to its own copy of
 * the page and has no view of document-level state. It needs one bit — does this
 * shape paint its interior with a visible shader — so that bit rides on the node
 * as a derived cache. It is written in the same commit as `materialId` and by
 * the same helpers here, so the two cannot drift; nothing else may set it.
 */

import type { PenpotNode, Uuid } from 'penpot-exporter/types'
import type { Material } from '../renderer/api/material'
import { docProxy } from '../renderer/store/doc-proxy'
import { commitChanges } from '../renderer/store/commit'
import type { DocMetaChange } from '../changes/doc-meta-change'
import {
  appendDocMetaPair,
  appendModObjPair,
  emptyChangesBuilder,
  toCommitBundle,
  type ChangesBuilder,
} from '../changes/changes-builder'

/** A node's material id, read structurally — it is an app-level field. */
export function materialIdOf(node: PenpotNode | null | undefined): Uuid | undefined {
  return (node as { materialId?: Uuid } | null | undefined)?.materialId
}

/** The material a shape paints with, or undefined when it has none. */
export function materialOf(node: PenpotNode | null | undefined): Material | undefined {
  const id = materialIdOf(node)
  return id === undefined ? undefined : docProxy.meta?.materials?.[id]
}

/** The material behind an id, for callers that already have one. */
export function materialById(id: Uuid | null | undefined): Material | undefined {
  return id == null ? undefined : docProxy.meta?.materials?.[id]
}

/**
 * Does this material paint the shape's interior? A shader fill covers the whole
 * interior like a regular fill, so a shape carrying one is interior-hittable
 * even with no `fills`. Kept here so the worker's cached bit and the resolver
 * can never disagree about what "has a shader" means.
 */
export function paintsInterior(material: Material | undefined): boolean {
  return (
    material !== undefined &&
    typeof material.source === 'string' &&
    material.source.trim().length > 0 &&
    !material.hidden
  )
}

/** The node fields that track a material. Written only by the helpers below. */
function nodePatch(id: Uuid | undefined, material: Material | undefined): Record<string, unknown> {
  return { materialId: id, shaded: paintsInterior(material) }
}

/**
 * Give a shape its own copy of `material`, replacing any it already had.
 *
 * Returns the new material's id. The old material is deleted in the same commit
 * — nothing else can be pointing at it, because assigning always copies.
 */
export async function assignMaterial(
  nodeId: Uuid,
  pageId: string,
  material: Material,
  before: PenpotNode,
): Promise<Uuid> {
  const previousId = materialIdOf(before)
  const previous = materialById(previousId)
  const id = crypto.randomUUID()

  const pairs: DocMetaPair[] = [
    { redo: { type: 'add-material', materialId: id, material }, undo: { type: 'del-material', materialId: id } },
  ]
  // The material being replaced goes in the same commit. Nothing else can point
  // at it, because assigning always copies.
  if (previousId !== undefined && previous !== undefined) {
    pairs.push({
      redo: { type: 'del-material', materialId: previousId },
      undo: { type: 'add-material', materialId: previousId, material: previous },
    })
  }

  await commitNodeAndMeta(nodeId, pageId, before, nodePatch(id, material), pairs)
  return id
}

/** Replace a material's value in place, keeping its identity and its history. */
export async function updateMaterial(
  materialId: Uuid,
  next: Material,
  node?: { id: Uuid; pageId: string; before: PenpotNode },
): Promise<void> {
  const previous = materialById(materialId)
  if (previous === undefined) return

  const pairs: DocMetaPair[] = [
    {
      redo: { type: 'mod-material', materialId, material: next },
      undo: { type: 'mod-material', materialId, material: previous },
    },
  ]

  // The cached bit only has to move when visibility or emptiness changed.
  if (node !== undefined && paintsInterior(previous) !== paintsInterior(next)) {
    await commitNodeAndMeta(node.id, node.pageId, node.before, nodePatch(materialId, next), pairs)
    return
  }
  await commitBundle(emptyBuilderWith(pairs, undefined))
}

/** Remove a shape's material entirely. */
export async function clearMaterial(
  nodeId: Uuid,
  pageId: string,
  before: PenpotNode,
): Promise<void> {
  const id = materialIdOf(before)
  const material = materialById(id)
  if (id === undefined || material === undefined) return

  await commitNodeAndMeta(nodeId, pageId, before, nodePatch(undefined, undefined), [
    {
      redo: { type: 'del-material', materialId: id },
      undo: { type: 'add-material', materialId: id, material },
    },
  ])
}

interface DocMetaPair {
  redo: DocMetaChange
  undo: DocMetaChange
}

function emptyBuilderWith(pairs: DocMetaPair[], pageId: string | undefined): ChangesBuilder {
  let builder = emptyChangesBuilder({ pageId })
  for (const pair of pairs) builder = appendDocMetaPair(builder, pair)
  return builder
}

async function commitBundle(builder: ChangesBuilder): Promise<void> {
  await commitChanges(toCommitBundle(builder))
}

/**
 * One commit carrying both arms, so the node's pointer and the material land
 * together and a single undo takes both back. Split across two commits they
 * would be two history steps, and the state in between would be a shape
 * pointing at a material that does not exist.
 */
async function commitNodeAndMeta(
  nodeId: Uuid,
  pageId: string,
  before: PenpotNode,
  patch: Record<string, unknown>,
  pairs: DocMetaPair[],
): Promise<void> {
  // Every key is snapshotted, including ones whose value is undefined. The
  // shared `snapshotAttrsForUndo` drops those, and the codec does turn out to
  // read an absent key as undefined — a mutation test confirmed clearing still
  // works without this. It stays explicit anyway: whether a shape stops pointing
  // at a material it no longer has should not rest on that inference.
  const rec = before as unknown as Record<string, unknown>
  const undoAssign: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    const v = rec[key]
    undoAssign[key] = v !== null && typeof v === 'object' ? structuredClone(v) : v
  }
  const builder = appendModObjPair(emptyBuilderWith(pairs, pageId), pageId, nodeId, {
    redoAssign: patch,
    undoAssign,
  })
  await commitBundle(builder)
}
