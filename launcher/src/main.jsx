import { installNativeBridge } from './lib/nativeBridge.js'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// 0.6.0 模块一：Android Capacitor 下注入与桌面同构的 window.mcnext（Electron 下为 no-op）
installNativeBridge()

createRoot(document.getElementById('root')).render(<App />)
