/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_ENABLE_BUILD_DEBUG?: string
  readonly VITE_ENABLE_EDITOR_PANELS?: string
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
