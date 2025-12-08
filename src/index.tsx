import React from 'react'
import ReactDOM from 'react-dom/client'

import './index.css'
import App from '@/plugin-ui/App.tsx'
import wrapInProviders from '@/plugin-ui/providers/wrapInProviders'
import { initSentry, Sentry } from '@/plugin-ui/utils/sentry'

// Initialize Sentry for error tracking
initSentry()

const root = document.getElementById('root')
ReactDOM.createRoot(root!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<div>An error occurred. Please refresh the page.</div>}>
      {wrapInProviders({ children: <App /> })}
    </Sentry.ErrorBoundary>
  </React.StrictMode>
)
