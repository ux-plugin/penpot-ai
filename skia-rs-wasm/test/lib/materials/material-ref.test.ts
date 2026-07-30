/**
 * Assigning, editing and clearing a material over the real commit pipeline.
 *
 * The case worth the test is undo of an assign onto a shape that had no
 * material: the pointer and the material land in one commit, so one undo has to
 * take both back. The shared undo-snapshot helper drops keys whose value is
 * undefined, which would leave the shape pointing at a material that same undo
 * had just deleted — hence the local snapshot in `material-ref`.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { PenpotNode } from 'penpot-exporter/types'
import { redo, setDocument, undo } from '../../../src/lib/page-crud'
import { docProxy } from '../../../src/lib/renderer/store/doc-proxy'
import { useJournalStore } from '../../../src/lib/history/journal/journal-store'
import {
  assignMaterial,
  clearMaterial,
  materialIdOf,
  materialOf,
  paintsInterior,
  updateMaterial,
} from '../../../src/lib/materials/material-ref'
import type { Material } from '../../../src/lib/renderer/api/material'
import { makeBaseDocument, resetWorkspace, PAGE_ID, RECT_ID } from '../fixtures'

const noise: Material = { source: 'half4 main(float2 p){ return half4(1); }' }

const rect = () => docProxy.pageMap.get(PAGE_ID)!.objects[RECT_ID] as PenpotNode
const materials = () => docProxy.meta?.materials ?? {}

beforeEach(() => {
  resetWorkspace()
  useJournalStore.getState().clear()
  setDocument(makeBaseDocument())
})

describe('material assignment', () => {
  it('gives the shape its own material and marks it shaded', async () => {
    const id = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())

    expect(materialIdOf(rect())).toBe(id)
    expect(materialOf(rect())).toEqual(noise)
    expect((rect() as { shaded?: boolean }).shaded).toBe(true)
  })

  it('mints a new id per assignment, so two shapes never share', async () => {
    const first = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())
    const second = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())

    expect(second).not.toBe(first)
    // Replacing drops the old one in the same commit — nothing points at it.
    expect(materials()[first]).toBeUndefined()
    expect(materials()[second]).toEqual(noise)
  })

  it('undoes an assignment completely — pointer and material together', async () => {
    const id = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())

    await undo()
    expect(materialIdOf(rect())).toBeUndefined()
    expect(materials()[id]).toBeUndefined()
    expect(materialOf(rect())).toBeUndefined()

    await redo()
    expect(materialIdOf(rect())).toBe(id)
    expect(materialOf(rect())).toEqual(noise)
  })

  it('edits in place, keeping the id and therefore the history', async () => {
    const id = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())
    const edited: Material = { source: 'half4 main(float2 p){ return half4(0); }' }
    await updateMaterial(id, edited)

    expect(materialIdOf(rect())).toBe(id)
    expect(materialOf(rect())).toEqual(edited)

    await undo()
    expect(materialOf(rect())).toEqual(noise)
    expect(materialIdOf(rect())).toBe(id)
  })

  it('moves the cached shaded bit when visibility changes', async () => {
    const id = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())
    await updateMaterial(id, { ...noise, hidden: true }, {
      id: RECT_ID,
      pageId: PAGE_ID,
      before: rect(),
    })

    expect((rect() as { shaded?: boolean }).shaded).toBe(false)
    expect(paintsInterior(materialOf(rect()))).toBe(false)
  })

  it('clears the material, and undo puts it back', async () => {
    const id = await assignMaterial(RECT_ID, PAGE_ID, noise, rect())
    await clearMaterial(RECT_ID, PAGE_ID, rect())

    expect(materialIdOf(rect())).toBeUndefined()
    expect(materials()[id]).toBeUndefined()

    await undo()
    expect(materialIdOf(rect())).toBe(id)
    expect(materialOf(rect())).toEqual(noise)
  })

  it('treats an empty or hidden shader as not painting the interior', () => {
    expect(paintsInterior(noise)).toBe(true)
    expect(paintsInterior({ source: '   ' })).toBe(false)
    expect(paintsInterior({ ...noise, hidden: true })).toBe(false)
    expect(paintsInterior(undefined)).toBe(false)
  })
})
