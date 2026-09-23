/**
 * persistence — public entry. The app talks to the document library through
 * here: the capability-selected store, and the session verbs that keep the
 * open document, the store and the persister in step.
 */

export type { DocumentStore, CommitRequest } from './document-store'
export type { DocumentSummary, PageSummary, Project } from './document-summary'
export { boardCount, pageCount } from './document-summary'

export { getPersistenceProvider } from './provider'
export { storeError } from './worker-store'
export {
  activeDocumentId,
  checkout,
  closeDocument,
  continueCandidate,
  createDocument,
  deleteDocument,
  documentLog,
  openDocument,
  recordHistory,
  renameDocument,
  sessionPersister,
} from './document-session'
