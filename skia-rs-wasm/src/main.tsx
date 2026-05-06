import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// `/perf` is an opt-in dev-only route that mounts the perf bench
// harness. The page lives under `test/perf/page/` so the production
// library bundle (entry: `src/index.ts`) never imports it. The dev
// SPA pulls it in only when the route is hit, via dynamic import.
const PerfPage = lazy(() => import('../test/perf/page/perf-page'))
const isPerfRoute =
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/+$/, '') === '/perf'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPerfRoute ? (
      <Suspense fallback={<div style={{ padding: 16 }}>loading perf harness…</div>}>
        <PerfPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
