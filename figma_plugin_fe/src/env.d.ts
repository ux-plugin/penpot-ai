/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
  readonly VITE_CDN_URL?: string
  readonly VITE_PLUGIN_UI_URL?: string
  readonly VITE_PLUGIN_ID?: string
  readonly VITE_FRONTEND_BASE_PATH: string
  readonly VITE_CLIENT_STORAGE_TYPE: 'BROWSER' | 'FIGMA'
}
