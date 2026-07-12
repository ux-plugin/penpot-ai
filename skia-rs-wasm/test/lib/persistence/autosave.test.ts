/**
 * Autosave: edits coalesce into one debounced save, a non-persisting provider is
 * inert, and disposing stops it. Drives the real commit emitter (`emitChangesApplied`)
 * with empty events; the document snapshot comes from the real documentModel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangesAppliedEvent } from '../../../src/lib/changes/change-emitter'
import { emitChangesApplied } from '../../../src/lib/changes/change-emitter'
import { docProxy, type DocumentMeta } from '../../../src/lib/renderer/store/doc-proxy'
import { useWorkspaceStore } from '../../../src/lib/renderer/store/workspace-store'
import { startDocumentAutosave } from '../../../src/lib/persistence/autosave'
import type { DocumentPersistenceProvider } from '../../../src/lib/persistence/document-persistence'

const EMPTY_EVENT: ChangesAppliedEvent = {
  redoChanges: [],
  undoChanges: [],
  pages: [],
  fromHistory: false,
  saveUndo: true,
  ignoreRendererSync: false,
}

type SpyProvider = DocumentPersistenceProvider & { save: ReturnType<typeof vi.fn> }

function provider(canPersist: boolean): SpyProvider {
  return {
    id: canPersist ? 'indexeddb' : 'none',
    canPersist,
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  } as SpyProvider
}

describe('document autosave', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    docProxy.meta = { name: 'Test' } as DocumentMeta
    docProxy.pageMap.clear()
    useWorkspaceStore.setState({ renderer: null })
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('coalesces a burst of edits into a single debounced save', async () => {
    const p = provider(true)
    dispose = startDocumentAutosave(p, 500)

    await emitChangesApplied(EMPTY_EVENT)
    await emitChangesApplied(EMPTY_EVENT)
    expect(p.save).not.toHaveBeenCalled() // still within the debounce window

    vi.advanceTimersByTime(500)
    expect(p.save).toHaveBeenCalledTimes(1)
  })

  it('is inert when the provider cannot persist', async () => {
    const p = provider(false)
    dispose = startDocumentAutosave(p, 500)

    await emitChangesApplied(EMPTY_EVENT)
    vi.advanceTimersByTime(1000)
    expect(p.save).not.toHaveBeenCalled()
  })

  it('stops saving after dispose', async () => {
    const p = provider(true)
    const stop = startDocumentAutosave(p, 500)
    stop()

    await emitChangesApplied(EMPTY_EVENT)
    vi.advanceTimersByTime(500)
    expect(p.save).not.toHaveBeenCalled()
  })
})
