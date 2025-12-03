import React from 'react'
import ReactDOM from 'react-dom/client'

import './index.css'
import App from '@app/App'
import wrapInProviders from '@app/providers/wrapInProviders'

const root = document.getElementById('root')
ReactDOM.createRoot(root!).render(
  <React.StrictMode>
    {wrapInProviders({ children: <App /> })}
  </React.StrictMode>
)
