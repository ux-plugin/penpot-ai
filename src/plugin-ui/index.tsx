import React from 'react'
import ReactDOM from 'react-dom/client'

import './index.css'
import App from './App.tsx'
import wrapInProviders from '@/plugin-ui/providers/wrapInProviders.tsx'

const root = document.getElementById('root')
ReactDOM.createRoot(root!).render(
  <React.StrictMode>
    {wrapInProviders({ children: <App /> })}
  </React.StrictMode>
)
