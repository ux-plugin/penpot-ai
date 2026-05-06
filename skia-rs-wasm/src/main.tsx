import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// `/perf` is an opt-in dev-only route that mounts the perf bench
// harness instead of the editor. The chunk is dynamically imported so
// production builds don't pay the bytes when navigated to /.
const PerfPage = lazy(() => import('./lib/perf/perf-page'))
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
