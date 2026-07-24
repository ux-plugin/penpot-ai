import { ipcMain } from 'electron'
import { generateText, type LanguageModel } from 'ai'
import { CHAT_CHANNELS, type ChatCompleteRequest, type ChatCompleteResponse, type LlmProvider } from '../shared/byok'
import { getActiveKey } from './byok'

/**
 * Main-process chat: the BYOK provider call.
 *
 * The renderer sends a fully-built prompt; we resolve the stored key + model from the
 * vault, call the provider directly from Node (no CORS, key never in renderer JS), and
 * return the assistant text. If no key is stored we throw, so the renderer falls back to
 * the platform facade. The provider SDK is imported lazily so only the selected
 * provider's package is loaded.
 */

async function buildModel(provider: LlmProvider, model: string, apiKey: string): Promise<LanguageModel> {
  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      return createAnthropic({ apiKey })(model)
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({ apiKey })(model)
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      return createGoogleGenerativeAI({ apiKey })(model)
    }
  }
}

async function complete(req: ChatCompleteRequest): Promise<ChatCompleteResponse> {
  const active = getActiveKey()
  if (!active) throw new Error('No BYOK key is stored.')
  const prompt = req?.prompt?.trim() ?? ''
  if (!prompt) throw new Error('The prompt is empty.')

  const model = await buildModel(active.meta.provider, active.meta.model, active.key)
  const { text } = await generateText({ model, prompt })
  return { text }
}

/** Register the chat IPC handler. Call once, after app `ready`. */
export function registerChatIpc(): void {
  ipcMain.handle(CHAT_CHANNELS.complete, (_event, req: ChatCompleteRequest) => complete(req))
}
