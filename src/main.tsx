import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { TipProvider } from './components/Tip'
import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <TipProvider>
      <App />
    </TipProvider>
  </React.StrictMode>,
)
