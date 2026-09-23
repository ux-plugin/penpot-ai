/**
 * DocumentsHome — the app's front door, at `/`.
 *
 * Renders over the editor rather than replacing it (see App.tsx): the canvas
 * stays mounted underneath so returning to a document doesn't re-initialise the
 * WASM renderer, and never sees a size change.
 *
 * Every list behaviour lives in ./document-list.ts so it can be tested without a
 * DOM; this file is composition and event wiring.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FilePlus2, MoreHorizontal, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  boardCount,
  createDocument,
  deleteDocument,
  getPersistenceProvider,
  renameDocument,
  pageCount,
  storeError,
  type DocumentSummary,
  type Project,
} from '../../persistence'
import { navigate, routeNotice } from '../../routing/route'
import { useSignalValue } from '../../renderer/signals/use-signal-value'
import {
  ALL,
  continueDocument,
  describeEdited,
  describeSize,
  nextCopyName,
  tintFor,
  visibleDocuments,
  type Scope,
} from './document-list'
import { PageStrip } from './PageStrip'
import { Rail } from './Rail'

/** Row actions live in a portalled popover — the pattern TokensPanel already
 *  uses; there's no shadcn dropdown-menu in this project. */
function RowMenu({
  doc,
  projects,
  onRename,
  onDuplicate,
  onDelete,
  onArchive,
  onFile,
}: {
  doc: DocumentSummary
  projects: Project[]
  onRename: (doc: DocumentSummary) => void
  onDuplicate: (doc: DocumentSummary) => void
  onDelete: (doc: DocumentSummary) => void
  onArchive: (doc: DocumentSummary, archived: boolean) => void
  onFile: (doc: DocumentSummary, projectId: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const items: Array<[string, () => void]> = [
    ['Rename', () => onRename(doc)],
    ['Duplicate', () => onDuplicate(doc)],
    ...projects
      .filter((p) => p.id !== doc.projectId)
      .map((p): [string, () => void] => [`Move to ${p.name}`, () => onFile(doc, p.id)]),
    ...(doc.projectId
      ? [['Remove from project', () => onFile(doc, null)] as [string, () => void]]
      : []),
    [doc.archived ? 'Unarchive' : 'Archive', () => onArchive(doc, !doc.archived)],
    ['Delete', () => onDelete(doc)],
  ]

  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`More actions for ${doc.name}`}
        className="opacity-0 group-hover:opacity-100 aria-expanded:opacity-100"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect) setAnchor({ top: rect.bottom + 4, left: rect.right - 160 })
          setOpen((v) => !v)
        }}
      >
        <MoreHorizontal className="size-4" />
      </Button>
      {open &&
        anchor &&
        createPortal(
          <div
            role="menu"
            className="fixed z-100 w-40 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-md"
            style={{ top: anchor.top, left: anchor.left }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {items.map(([label, run]) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-muted ${
                  label === 'Delete' ? 'text-destructive' : ''
                }`}
                onClick={() => {
                  setOpen(false)
                  run()
                }}
              >
                {label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

/** Everything the screen reads from the store, sampled together. `now` is part of
 *  the snapshot so relative times ("2 hours ago") are fixed at load rather than
 *  re-read on every render — a clock read during render isn't pure, and times
 *  that shift on an unrelated re-render are a distraction. */
interface Library {
  documents: DocumentSummary[]
  projects: Project[]
  lastOpenedId: string | null
  now: number
}

async function readLibrary(): Promise<Library> {
  const provider = getPersistenceProvider()
  const [documents, projects, lastOpenedId] = await Promise.all([
    provider.list(),
    provider.listProjects(),
    provider.getActiveId(),
  ])
  return { documents, projects, lastOpenedId, now: Date.now() }
}

export function DocumentsHome() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>(ALL)
  const notice = useSignalValue(routeNotice)
  const unavailable = useSignalValue(storeError)

  // Reading the store is a subscription to an external system, so state lands in
  // the callback; `alive` drops a load that resolves after an unmount.
  useEffect(() => {
    let alive = true
    readLibrary().then(
      (next) => {
        if (alive) setLibrary(next)
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])

  /** Re-read after a mutation. Called from handlers, never from an effect. */
  const refresh = useCallback(async () => setLibrary(await readLibrary()), [])

  const documents = library?.documents ?? null
  const projects = library?.projects ?? []
  const now = library?.now ?? 0

  const open = useCallback((id: string) => navigate({ kind: 'doc', id }), [])

  const onNew = useCallback(async () => {
    const summary = await createDocument()
    // A document made while a project is selected lands in that project, which
    // is what "New document" inside a folder is expected to mean.
    if (scope.kind === 'project') {
      await getPersistenceProvider().setProject(summary.id, scope.projectId)
    }
    navigate({ kind: 'doc', id: summary.id })
  }, [scope])

  const onArchive = useCallback(
    async (doc: DocumentSummary, archived: boolean) => {
      await getPersistenceProvider().setArchived(doc.id, archived)
      await refresh()
    },
    [refresh],
  )

  const onFile = useCallback(
    async (doc: DocumentSummary, projectId: string | null) => {
      await getPersistenceProvider().setProject(doc.id, projectId)
      await refresh()
    },
    [refresh],
  )

  const onCreateProject = useCallback(
    async (name: string) => {
      const project = await getPersistenceProvider().createProject(name)
      await refresh()
      setScope({ kind: 'project', projectId: project.id })
    },
    [refresh],
  )

  const onRenameProject = useCallback(
    async (project: Project) => {
      const name = window.prompt('Rename project', project.name)?.trim()
      if (!name || name === project.name) return
      await getPersistenceProvider().renameProject(project.id, name)
      await refresh()
    },
    [refresh],
  )

  const onDeleteProject = useCallback(
    async (project: Project) => {
      if (
        !window.confirm(
          `Delete the project “${project.name}”? Its documents stay in the library, unfiled.`,
        )
      )
        return
      await getPersistenceProvider().deleteProject(project.id)
      setScope(ALL)
      await refresh()
    },
    [refresh],
  )

  const onRename = useCallback(
    async (doc: DocumentSummary) => {
      const name = window.prompt('Rename document', doc.name)?.trim()
      if (!name || name === doc.name) return
      await renameDocument(doc.id, name)
      await refresh()
    },
    [refresh],
  )

  const onDuplicate = useCallback(
    async (doc: DocumentSummary) => {
      const provider = getPersistenceProvider()
      const copy = await provider.duplicate(doc.id)
      // `duplicate` names the copy from the source; make it unique against what's
      // already listed so a third copy isn't indistinguishable from the second.
      if (copy) {
        const unique = nextCopyName(documents ?? [], doc.name)
        if (unique !== copy.name) await provider.rename(copy.id, unique)
      }
      await refresh()
    },
    [documents, refresh],
  )

  const onDelete = useCallback(
    async (doc: DocumentSummary) => {
      const size = describeSize(doc)
      if (!window.confirm(`Delete “${doc.name}”? It has ${size}. This can't be undone.`)) return
      await deleteDocument(doc.id)
      await refresh()
    },
    [refresh],
  )

  const rows = visibleDocuments(documents ?? [], query, scope)
  // Continue is about the library as a whole, so it stays put while you browse a
  // project — but it's hiding when you've narrowed the list, where a big card
  // for something outside your filter would only be in the way.
  const narrowed = query !== '' || scope.kind !== 'all'
  const resume = narrowed ? null : continueDocument(documents ?? [], library?.lastOpenedId ?? null)
  const scopeLabel =
    scope.kind === 'archived'
      ? 'Archive'
      : scope.kind === 'project'
        ? (projects.find((p) => p.id === scope.projectId)?.name ?? 'Project')
        : 'All documents'

  return (
    <div className="absolute inset-0 z-50 flex bg-background font-sans text-foreground">
      <Rail
        documents={documents ?? []}
        projects={projects}
        scope={scope}
        onScope={setScope}
        onCreateProject={(name) => void onCreateProject(name)}
        onRenameProject={(p) => void onRenameProject(p)}
        onDeleteProject={(p) => void onDeleteProject(p)}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background px-7 py-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents and pages"
            aria-label="Search documents and pages"
            className="pl-8"
          />
        </div>
        <Button type="button" className="ml-auto" onClick={() => void onNew()}>
          <FilePlus2 className="size-4" />
          New document
        </Button>
      </header>

      <div className="flex flex-col gap-7 px-7 pb-14 pt-6">
        {(notice || unavailable) && (
          <div
            role="status"
            className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
          >
            {unavailable ?? notice}
          </div>
        )}

        {unavailable ? null : documents === null ? (
          <p className="text-sm text-muted-foreground">Loading documents…</p>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-16">
            <h1 className="text-xl font-medium">Start your first document</h1>
            <p className="max-w-prose text-sm text-muted-foreground">
              Documents hold pages, and pages hold boards. Everything you create is saved on this
              device as you work.
            </p>
            <Button type="button" onClick={() => void onNew()}>
              <FilePlus2 className="size-4" />
              New document
            </Button>
          </div>
        ) : (
          <>
            {resume && (
              <section>
                <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  Continue
                </h2>
                <div
                  className="flex cursor-pointer items-stretch gap-5 border border-l-[3px] border-border bg-card p-5 hover:bg-muted/40"
                  style={{ borderLeftColor: tintFor(resume.id) }}
                  onClick={() => open(resume.id)}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h3 className="truncate text-xl font-medium tracking-tight">{resume.name}</h3>
                    <span className="text-xs text-muted-foreground">{describeSize(resume)}</span>
                    <span className="text-xs text-muted-foreground">
                      Edited {describeEdited(resume.updatedAt, now).toLowerCase()}
                    </span>
                    <div className="mt-auto pt-3">
                      <Button type="button" onClick={() => open(resume.id)}>
                        Open
                      </Button>
                    </div>
                  </div>
                  <PageStrip
                    pages={resume.pages}
                    tint={tintFor(resume.id)}
                    captions
                    cellWidth={112}
                    cellHeight={78}
                  />
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                {scopeLabel}
                <span className="ml-2.5 normal-case tracking-normal">
                  {rows.length} {rows.length === 1 ? 'document' : 'documents'}
                </span>
              </h2>

              {rows.length === 0 ? (
                <p className="py-7 text-sm text-muted-foreground">
                  {query
                    ? `No document or page in ${scopeLabel} matches “${query}”.`
                    : scope.kind === 'archived'
                      ? 'Nothing archived. Archiving a document keeps it here, out of the main list.'
                      : scope.kind === 'project'
                        ? `No documents in ${scopeLabel} yet. File one here from its row menu.`
                        : 'No documents yet.'}
                </p>
              ) : (
                <div className="flex flex-col">
                  <div className="grid grid-cols-[minmax(180px,1.4fr)_minmax(120px,2.3fr)_62px_66px_120px_32px] items-center border-b border-border pb-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                    <span className="px-3">Document</span>
                    <span />
                    <span className="px-3">Pages</span>
                    <span className="px-3">Boards</span>
                    <span className="px-3">Edited</span>
                    <span />
                  </div>
                  {rows.map((doc) => (
                    <div
                      key={doc.id}
                      className="group grid cursor-pointer grid-cols-[minmax(180px,1.4fr)_minmax(120px,2.3fr)_62px_66px_120px_32px] items-center border-b border-l-[3px] border-border border-l-transparent hover:bg-muted/40"
                      style={{ height: 62 }}
                      onClick={() => open(doc.id)}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderLeftColor = tintFor(doc.id)
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderLeftColor = 'transparent'
                      }}
                    >
                      <span className="truncate px-3 text-sm font-medium">{doc.name}</span>
                      <div className="overflow-hidden">
                        <PageStrip pages={doc.pages} tint={tintFor(doc.id)} />
                      </div>
                      <span className="px-3 font-mono text-xs tabular-nums text-muted-foreground">
                        {pageCount(doc)}
                      </span>
                      <span className="px-3 font-mono text-xs tabular-nums text-muted-foreground">
                        {boardCount(doc)}
                      </span>
                      <span className="px-3 text-xs text-muted-foreground">
                        {describeEdited(doc.updatedAt, now)}
                      </span>
                      <RowMenu
                        doc={doc}
                        projects={projects}
                        onRename={(d) => void onRename(d)}
                        onDuplicate={(d) => void onDuplicate(d)}
                        onDelete={(d) => void onDelete(d)}
                        onArchive={(d, archived) => void onArchive(d, archived)}
                        onFile={(d, projectId) => void onFile(d, projectId)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      </div>
    </div>
  )
}
