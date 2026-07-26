import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { connectDevMcp } from './devMcp'

// no-op in a production build — import.meta.hot is undefined there
connectDevMcp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
