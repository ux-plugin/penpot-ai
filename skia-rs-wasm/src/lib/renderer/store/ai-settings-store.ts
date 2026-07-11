/**
 * AI provider settings for Build-mode authoring (configured in the Settings
 * dialog). BYOK: the user supplies their own OpenRouter API key and a model
 * slug; the chat calls OpenRouter directly with them (see `nl/ai-cli.ts`).
 *
 * Persisted to localStorage so the key survives reloads. NOTE: a key in
 * localStorage is readable by any script on the page (standard BYOK trade-off);
 * fine for a local design tool, not a place for a shared/production secret.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AiSettings {
  /** OpenRouter API key (`sk-or-...`). Empty = use the dev bridge fallback. */
  apiKey: string
  /** OpenRouter model slug; `openrouter/auto` lets OpenRouter route. */
  model: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  apiKey: '',
  model: 'openrouter/auto',
}

interface AiSettingsState {
  ai: AiSettings
  setAi: (partial: Partial<AiSettings>) => void
  resetAi: () => void
}

export const useAiSettingsStore = create<AiSettingsState>()(
  persist(
    (set) => ({
      ai: { ...DEFAULT_AI_SETTINGS },
      setAi: (partial) => set((state) => ({ ai: { ...state.ai, ...partial } })),
      resetAi: () => set({ ai: { ...DEFAULT_AI_SETTINGS } }),
    }),
    { name: 'penpot-ai.ai-settings' },
  ),
)

/** Read current AI settings without subscribing (e.g. inside `aiChat`). */
export function getAiSettings(): AiSettings {
  return useAiSettingsStore.getState().ai
}
