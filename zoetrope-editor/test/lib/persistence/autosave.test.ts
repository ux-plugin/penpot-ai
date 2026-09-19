/**
 * Autosave: edits coalesce into one debounced save against the open document, a
 * non-persisting provider is inert, an edit with no document open goes nowhere,
 * and disposing stops it. Drives the real commit emitter (`emitChangesApplied`)
 * with empty events; the document snapshot comes from the real documentModel and
 * the destination from the real `activeDocumentId` signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangesAppliedEvent } from '../../../src/lib/changes/change-emitter'
import { emitChangesApplied } from '../../../src/lib/changes/change-emitter'
import { docProxy, type DocumentMeta } from '../../../src/lib/renderer/store/doc-proxy'
import { useWorkspaceStore } from '../../../src/lib/renderer/store/workspace-store'
import { startDocumentAutosave } from '../../../src/lib/persistence/autosave'
import { activeDocumentId } from '../../../src/lib/persistence/document-session'
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
    list: vi.fn(async () => []),
    load: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    create: vi.fn(),
    duplicate: vi.fn(async () => null),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    getActiveId: vi.fn(async () => null),
    setActiveId: vi.fn(async () => {}),
  } as unknown as SpyProvider
}

describe('document autosave', () => {
  let dispose: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    docProxy.meta = { name: 'Test' } as DocumentMeta
    docProxy.pageMap.clear()
    useWorkspaceStore.setState({ renderer: null })
    activeDocumentId.value = 'doc-1'
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    activeDocumentId.value = null
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
    // Saved against the open document, not a guessed destination.
    expect(p.save.mock.calls[0]![0]).toBe('doc-1')
  })

  it('saves to whichever document is open when the edit settles', async () => {
    const p = provider(true)
    dispose = startDocumentAutosave(p, 500)

    await emitChangesApplied(EMPTY_EVENT)
    activeDocumentId.value = 'doc-2'
    vi.advanceTimersByTime(500)

    expect(p.save.mock.calls[0]![0]).toBe('doc-2')
  })

  it('saves nothing when no document is open', async () => {
    const p = provider(true)
    activeDocumentId.value = null
    dispose = startDocumentAutosave(p, 500)

    await emitChangesApplied(EMPTY_EVENT)
    vi.advanceTimersByTime(1000)
    expect(p.save).not.toHaveBeenCalled()
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
