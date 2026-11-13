import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './app/App'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container #root is missing from index.html')
}

// Dev/test automation bridge — never present in production builds.
if (import.meta.env.DEV) {
  void import('./app/devBridge').then(({ installDevBridge }) => installDevBridge())
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
