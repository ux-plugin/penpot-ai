/// <reference types="vite/client" />

interface DesktopApi {
  platform: string
  versions: { electron: string; chrome: string; node: string }
}

interface Window {
  desktop: DesktopApi
}
