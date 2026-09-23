/**
 * The library: which documents exist, what the documents screen shows for
 * each, projects, and the last-open document. Library facts only; a
 * document's content lives in its own database.
 */
import type { Sql } from '../doc/commits'
import type { DerivedSummary, DocumentSummary, PageSummary, Project } from './document-summary'

const SCHEMA = `
pragma temp_store = memory;
create table if not exists documents(
  id text primary key, name text not null, pages text not null,
  created_at integer not null, updated_at integer not null,
  archived integer not null default 0, project_id text
);
create table if not exists projects(id text primary key, name text not null, created_at integer not null);
create table if not exists settings(key text primary key, value text not null);
`

interface DocumentRow {
  id: string
  name: string
  pages: string
  created_at: number
  updated_at: number
  archived: number
  project_id: string | null
}

function toSummary(r: DocumentRow): DocumentSummary {
  const s: DocumentSummary = {
    id: r.id,
    name: r.name,
    pages: JSON.parse(r.pages) as PageSummary[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
  if (r.archived) s.archived = true
  if (r.project_id) s.projectId = r.project_id
  return s
}

export class LibraryDb {
  constructor(private readonly sql: Sql) {
    sql.run(SCHEMA)
  }

  /** Newest first. */
  list(): DocumentSummary[] {
    return this.sql.all<DocumentRow>('select * from documents order by updated_at desc, id').map(toSummary)
  }

  get(id: string): DocumentSummary | null {
    const r = this.sql.all<DocumentRow>('select * from documents where id = ?', [id])[0]
    return r ? toSummary(r) : null
  }

  /** Insert or refresh what the document says about itself; archive and project stay. */
  put(id: string, summary: DerivedSummary, at: number): DocumentSummary {
    this.sql.run(
      `insert into documents(id, name, pages, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict(id) do update set name = excluded.name, pages = excluded.pages, updated_at = excluded.updated_at`,
      [id, summary.name, JSON.stringify(summary.pages), at, at],
    )
    return this.get(id)!
  }

  remove(id: string): void {
    this.sql.run('delete from documents where id = ?', [id])
    this.sql.run("delete from settings where key = 'active' and value = ?", [id])
  }

  /** Archiving is not an edit: `updated_at` stays. */
  setArchived(id: string, archived: boolean): void {
    this.sql.run('update documents set archived = ? where id = ?', [archived ? 1 : 0, id])
  }

  setProject(id: string, projectId: string | null): void {
    this.sql.run('update documents set project_id = ? where id = ?', [projectId, id])
  }

  listProjects(): Project[] {
    return this.sql
      .all<{ id: string; name: string; created_at: number }>('select * from projects order by name, id')
      .map((p) => ({ id: p.id, name: p.name, createdAt: p.created_at }))
  }

  createProject(project: Project): void {
    this.sql.run('insert into projects(id, name, created_at) values (?, ?, ?)', [project.id, project.name, project.createdAt])
  }

  renameProject(id: string, name: string): void {
    this.sql.run('update projects set name = ? where id = ?', [name, id])
  }

  /** Its documents stay, unfiled. */
  deleteProject(id: string): void {
    this.sql.transaction(() => {
      this.sql.run('delete from projects where id = ?', [id])
      this.sql.run('update documents set project_id = null where project_id = ?', [id])
    })
  }

  getActiveId(): string | null {
    return this.sql.all<{ value: string }>("select value from settings where key = 'active'")[0]?.value ?? null
  }

  setActiveId(id: string | null): void {
    if (id === null) this.sql.run("delete from settings where key = 'active'")
    else this.sql.run("insert into settings(key, value) values ('active', ?) on conflict(key) do update set value = excluded.value", [id])
  }
}
