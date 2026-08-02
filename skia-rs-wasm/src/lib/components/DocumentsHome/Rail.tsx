/**
 * Rail — the documents screen's left navigation: library scopes above, projects
 * below, storage at the foot.
 *
 * Scope selection is ordinary component state, not a route. The URL addresses
 * documents (`/d/<id>`); which slice of the list you're looking at is a view
 * preference, and putting it in the URL would mean every rail click became a
 * history entry to press Back through.
 */

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DocumentSummary, Project } from '../../persistence'
import { scopeCounts, tintFor, type Scope } from './document-list'

interface RailProps {
  documents: DocumentSummary[]
  projects: Project[]
  scope: Scope
  onScope: (scope: Scope) => void
  onCreateProject: (name: string) => void
  onRenameProject: (project: Project) => void
  onDeleteProject: (project: Project) => void
}

function ScopeButton({
  label,
  count,
  active,
  swatch,
  onClick,
  onContextMenu,
}: {
  label: string
  count?: number
  active: boolean
  swatch?: string
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${
        active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60'
      }`}
    >
      {swatch && (
        <span
          className="size-2 flex-none rounded-[2px]"
          style={{ background: swatch }}
          aria-hidden
        />
      )}
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </button>
  )
}

export function Rail({
  documents,
  projects,
  scope,
  onScope,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
}: RailProps) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const counts = scopeCounts(documents)

  const submit = () => {
    const name = draft.trim()
    if (name) onCreateProject(name)
    setDraft('')
    setAdding(false)
  }

  const onDevice = documents.length

  return (
    <aside className="flex h-full w-56 flex-none flex-col gap-5 overflow-y-auto border-r border-border bg-muted/30 px-3 py-4">
      <div className="flex items-center gap-2 px-2">
        <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" className="text-foreground">
          <circle cx="9" cy="9" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <line x1="9" y1="1.8" x2="9" y2="4.4" />
            <line x1="14.1" y1="3.9" x2="12.3" y2="5.7" />
            <line x1="16.2" y1="9" x2="13.6" y2="9" />
            <line x1="14.1" y1="14.1" x2="12.3" y2="12.3" />
            <line x1="9" y1="16.2" x2="9" y2="13.6" />
            <line x1="3.9" y1="14.1" x2="5.7" y2="12.3" />
            <line x1="1.8" y1="9" x2="4.4" y2="9" />
            <line x1="3.9" y1="3.9" x2="5.7" y2="5.7" />
          </g>
        </svg>
        <span className="text-sm font-medium tracking-tight">Zoetrope</span>
      </div>

      <nav className="flex flex-col gap-0.5" aria-label="Library">
        <ScopeButton
          label="All documents"
          count={counts.all}
          active={scope.kind === 'all'}
          onClick={() => onScope({ kind: 'all' })}
        />
        <ScopeButton
          label="Archive"
          count={counts.archived}
          active={scope.kind === 'archived'}
          onClick={() => onScope({ kind: 'archived' })}
        />
      </nav>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Projects
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="New project"
            title="New project"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3" />
          </Button>
        </div>

        {projects.map((project) => (
          <ScopeButton
            key={project.id}
            label={project.name}
            count={counts.byProject[project.id] ?? 0}
            swatch={tintFor(project.id)}
            active={scope.kind === 'project' && scope.projectId === project.id}
            onClick={() => onScope({ kind: 'project', projectId: project.id })}
            onContextMenu={(e) => {
              e.preventDefault()
              onRenameProject(project)
            }}
          />
        ))}

        {adding && (
          <input
            autoFocus
            value={draft}
            placeholder="Project name"
            aria-label="New project name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') {
                setDraft('')
                setAdding(false)
              }
            }}
            className="mx-2 rounded-md border border-border bg-background px-2 py-1 text-sm outline-none focus:border-ring"
          />
        )}

        {!projects.length && !adding && (
          <p className="px-2 text-xs text-muted-foreground">
            Group documents by filing them into a project.
          </p>
        )}

        {projects.length > 0 && scope.kind === 'project' && (
          <button
            type="button"
            className="mx-2 mt-1 text-left text-xs text-muted-foreground hover:text-destructive"
            onClick={() => {
              const project = projects.find((p) => p.id === scope.projectId)
              if (project) onDeleteProject(project)
            }}
          >
            Delete this project
          </button>
        )}
      </div>

      <p className="mt-auto px-2 text-[11px] text-muted-foreground">
        {onDevice} {onDevice === 1 ? 'document' : 'documents'} on this device
      </p>
    </aside>
  )
}
