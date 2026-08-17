import { useEffect } from 'react'
import type { WasmModule } from '../wasm-types'
import { ensureFontLoaded } from './text'
import { requestRender } from './rendering'
import { useWorkspaceStore } from '../store/workspace-store'
import { useFontAvailabilityStore } from '../store/font-availability'

/**
 * Re-attempt every face that previously fell back to the default (e.g. offline). On
 * success the loader flips it to `available` — clearing its red "i" reactively — and
 * the canvas re-renders with the real font. Faces still unreachable stay flagged.
 */
async function retrySubstitutedFonts(module: WasmModule): Promise<void> {
  const { byFace } = useFontAvailabilityStore.getState()
  const substituted = Object.keys(byFace).filter((k) => byFace[k] === 'substituted')
  if (!substituted.length) return

  const results = await Promise.all(
    substituted.map((key) => {
      // key = `${fontId}|${weight}|${i|n}` — fontId is a slug, so it has no `|`.
      const first = key.indexOf('|')
      const last = key.lastIndexOf('|')
      const fontId = key.slice(0, first)
      const fontWeight = Number(key.slice(first + 1, last))
      const fontStyle = key.slice(last + 1) === 'i' ? 'italic' : 'normal'
      return ensureFontLoaded(module, { fontId, fontWeight, fontStyle }).catch(() => false)
    }),
  )
  if (results.some(Boolean)) requestRender(module, 'font-reconnect')
}

/** Retry substituted fonts whenever the browser regains connectivity. */
export function useFontReconnect(): void {
  useEffect(() => {
    const onOnline = () => {
      const module = useWorkspaceStore.getState().wasmModule
      if (module) void retrySubstitutedFonts(module)
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])
}
