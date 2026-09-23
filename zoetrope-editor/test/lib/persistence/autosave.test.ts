/**
 * Autosave: edits coalesce into one debounced save against the open document, a
 * non-persisting provider is inert, an edit with no document open goes nowhere,
 * and disposing stops it. Drives the real commit pipeline (`commitChanges`) on a
 * seeded document; the snapshot comes from the real documentModel and the
 * destination from the real `activeDocumentId` signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitChanges, mod } from '../../../src/lib/doc'
import { useWorkspaceStore } from '../../../src/lib/renderer/store/workspace-store'
import { startDocumentAutosave } from '../../../src/lib/persistence/autosave'
import { activeDocumentId } from '../../../src/lib/persistence/document-session'
import type { DocumentPersistenceProvider } from '../../../src/lib/persistence/document-persistence'
import { makeBaseDocument, RECT_ID, resetWorkspace, seedDocument } from '../fixtures'

let edits = 0

/** One transient node edit — enough to fire `changes-applied`. */
async function edit(): Promise<void> {
  await commitChanges({ changes: [mod('node', RECT_ID, { x: ++edits })], saveUndo: false })
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
    resetWorkspace()
    seedDocument(makeBaseDocument())
    useWorkspaceStore.setState({ renderer: null, workerClient: null })
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

    await edit()
    await edit()
    expect(p.save).not.toHaveBeenCalled() // still within the debounce window

    vi.advanceTimersByTime(500)
    expect(p.save).toHaveBeenCalledTimes(1)
    // Saved against the open document, not a guessed destination.
    expect(p.save.mock.calls[0]![0]).toBe('doc-1')
    // ...and with the document as it stands.
    expect(p.save.mock.calls[0]![1]?.name).toBe('Test')
  })

  it('saves to whichever document is open when the edit settles', async () => {
    const p = provider(true)
    dispose = startDocumentAutosave(p, 500)

    await edit()
    activeDocumentId.value = 'doc-2'
    vi.advanceTimersByTime(500)

    expect(p.save.mock.calls[0]![0]).toBe('doc-2')
  })

  it('saves nothing when no document is open', async () => {
    const p = provider(true)
    activeDocumentId.value = null
    dispose = startDocumentAutosave(p, 500)

    await edit()
    vi.advanceTimersByTime(1000)
    expect(p.save).not.toHaveBeenCalled()
  })

  it('is inert when the provider cannot persist', async () => {
    const p = provider(false)
    dispose = startDocumentAutosave(p, 500)

    await edit()
    vi.advanceTimersByTime(1000)
    expect(p.save).not.toHaveBeenCalled()
  })

  it('stops saving after dispose', async () => {
    const p = provider(true)
    const stop = startDocumentAutosave(p, 500)
    stop()

    await edit()
    vi.advanceTimersByTime(500)
    expect(p.save).not.toHaveBeenCalled()
  })
})
