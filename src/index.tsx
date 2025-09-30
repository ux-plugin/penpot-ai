import React from 'react'
import ReactDOM from 'react-dom/client'

import './index.css'
import App from './App'
import wrapInProviders from './providers/wrapInProviders.tsx'

const root = document.getElementById('root')
ReactDOM.createRoot(root!).render(
  <React.StrictMode>
    {wrapInProviders({ children: <App /> })}
  </React.StrictMode>
)
