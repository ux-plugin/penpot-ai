/**
 * Public API for Worker initialization
 * Encapsulates init-in-progress guard and AbortController; updates store with worker client.
 */

import type { WorkerClient } from './worker/types'
import { createWorker } from './worker-factory'
import { useWorkspaceStore } from './renderer/store/workspace-store'

export class WorkerClientManager {
  private pendingAbort = false
  private initPromise: Promise<WorkerClient> | null = null

  /**
   * Idempotent while in flight: a second `init()` before the first resolves ADOPTS the same
   * promise — including one whose teardown was requested in between. That is the React
   * StrictMode dev double-mount (mount → cleanup → mount): the expensive part of
   * `createWorker` is the wasm fetch + compile, and abort-then-redo paid it twice serially on
   * every page load. Re-claiming clears the pending abort, so the one in-flight init serves
   * both mounts; a cleanup that nobody re-claims destroys the client at completion.
   */
  async init(workerScriptUrl?: string): Promise<WorkerClient> {
    const { workerClient } = useWorkspaceStore.getState()

    if (workerClient) {
      return workerClient
    }

    this.pendingAbort = false
    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this.doInit(workerScriptUrl)
    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async doInit(workerScriptUrl?: string): Promise<WorkerClient> {
    const { workerClient } = await createWorker(workerScriptUrl)

    if (this.pendingAbort) {
      this.pendingAbort = false
      workerClient.destroy()
      throw new Error('Worker initialization aborted')
    }

    useWorkspaceStore.getState().setWorkerClient(workerClient)
    return workerClient
  }

  cleanup(): void {
    if (this.initPromise) {
      this.pendingAbort = true
      return
    }

    const { workerClient } = useWorkspaceStore.getState()
    if (workerClient) {
      workerClient.destroy()
    }
    useWorkspaceStore.getState().setWorkerClient(null)
  }
}

const workerClientManager = new WorkerClientManager()

/**
 * Initialize the worker. When workerScriptUrl is provided (e.g. Figma plugin), uses that script; otherwise uses the bundled worker.
 */
export function initWorker(workerScriptUrl?: string): Promise<WorkerClient> {
  return workerClientManager.init(workerScriptUrl)
}

/**
 * Check if worker is ready (initialized in store)
 */
export function isWorkerReady(): boolean {
  return useWorkspaceStore.getState().workerClient !== null
}

/**
 * Get worker client from store
 */
export function getWorkerClient(): WorkerClient | null {
  return useWorkspaceStore.getState().workerClient
}

/**
 * Cleanup worker (terminates and clears from store)
 */
export function cleanupWorker(): void {
  workerClientManager.cleanup()
}
