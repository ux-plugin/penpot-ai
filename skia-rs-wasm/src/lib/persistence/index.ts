/**
 * persistence — public entry. The app talks to the document library through
 * here: the capability-selected provider, the session verbs that keep the open
 * document and the store in step, and the autosave loop.
 */

export type {
  DocumentPersistenceProvider,
  PersistenceProviderId,
} from './document-persistence'
export type { DocumentSummary, PageSummary, Project } from './document-summary'
export { boardCount, pageCount } from './document-summary'

export { getPersistenceProvider } from './provider'
export { startDocumentAutosave } from './autosave'
export {
  activeDocumentId,
  closeDocument,
  continueCandidate,
  createDocument,
  deleteDocument,
  openDocument,
} from './document-session'
