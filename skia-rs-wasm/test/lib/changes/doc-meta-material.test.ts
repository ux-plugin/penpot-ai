/**
 * The material arm of `DocMetaChange` — a shader is a document-level object that
 * shapes point at by id, not a field on one shape.
 *
 * Two things are pinned here. The reducer is immutable and invertible, so a
 * delete followed by its inverse add restores exactly what was there. And the
 * codec keys a material op by its id, which is what makes edits to two
 * materials commute while two edits to one collide.
 */

import { describe, expect, it } from 'vitest'
import {
  processDocMetaChange,
  processDocMetaChanges,
  type DocMetaChange,
} from '../../../src/lib/changes/doc-meta-change'
import { docMetaField } from '../../../src/lib/history/journal/codec'
import type { DocumentMeta } from '../../../src/lib/renderer/store/doc-proxy'
import type { Material } from '../../../src/lib/renderer/api/material'

const emptyMeta = (): DocumentMeta =>
  ({
    name: 'doc',
    components: {},
    images: {},
    paintStyles: {},
    textStyles: {},
    componentProperties: {},
    externalLibraries: {},
    missingFonts: [],
    isShared: false,
  }) as unknown as DocumentMeta

const noise: Material = { source: 'half4 main(float2 p){ return half4(1); }' }
const M = 'mat-1'

describe('doc-meta material arm', () => {
  it('adds, modifies and deletes without mutating the input', () => {
    const base = emptyMeta()
    const added = processDocMetaChange(base, { type: 'add-material', materialId: M, material: noise })

    expect(added.materials?.[M]).toEqual(noise)
    expect(base.materials).toBeUndefined() // the input is untouched

    const edited: Material = { ...noise, source: 'half4 main(float2 p){ return half4(0); }' }
    const modded = processDocMetaChange(added, { type: 'mod-material', materialId: M, material: edited })
    expect(modded.materials?.[M]).toEqual(edited)
    expect(added.materials?.[M]).toEqual(noise)

    const deleted = processDocMetaChange(modded, { type: 'del-material', materialId: M })
    expect(deleted.materials?.[M]).toBeUndefined()
    expect(modded.materials?.[M]).toEqual(edited)
  })

  it('round-trips a delete through its inverse', () => {
    const withIt = processDocMetaChange(emptyMeta(), {
      type: 'add-material',
      materialId: M,
      material: noise,
    })
    const back = processDocMetaChanges(withIt, [
      { type: 'del-material', materialId: M },
      { type: 'add-material', materialId: M, material: noise },
    ])
    expect(back.materials).toEqual(withIt.materials)
  })

  it('leaves other materials alone', () => {
    const two = processDocMetaChanges(emptyMeta(), [
      { type: 'add-material', materialId: M, material: noise },
      { type: 'add-material', materialId: 'mat-2', material: { source: 'other' } },
    ])
    const gone = processDocMetaChange(two, { type: 'del-material', materialId: M })
    expect(gone.materials?.['mat-2']).toEqual({ source: 'other' })
  })

  it('keys history ops by material id, so two materials commute', () => {
    const a: DocMetaChange = { type: 'mod-material', materialId: M, material: noise }
    const b: DocMetaChange = { type: 'del-material', materialId: M }
    const c: DocMetaChange = { type: 'add-material', materialId: 'mat-2', material: noise }

    expect(docMetaField(a)).toBe(docMetaField(b)) // same subject — these collide
    expect(docMetaField(a)).not.toBe(docMetaField(c)) // different subjects — independent
  })
})
