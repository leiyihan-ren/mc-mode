import React, { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/Sidebar.jsx'
import TitleBar from './components/TitleBar.jsx'
import HomePage from './pages/HomePage.jsx'
import DownloadPage from './pages/DownloadPage.jsx'
import ConsolePage from './pages/ConsolePage.jsx'
import ServerPage from './pages/ServerPage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import AccountPage from './pages/AccountPage.jsx'
import ModpackPage from './pages/ModpackPage.jsx'
import LocalJarPage from './pages/LocalJarPage.jsx'
import CrashPage from './pages/CrashPage.jsx'
import JavaManagerPage from './pages/JavaManagerPage.jsx'
import LobbyPage from './pages/LobbyPage.jsx'
import WorldManagerPage from './pages/WorldManagerPage.jsx'
import SkinPage from './pages/SkinPage.jsx'
import ModsPage from './pages/ModsPage.jsx'
import MobileNav from './components/MobileNav.jsx'
import { isMobile } from './lib/remote.js'

export default function App() {
  const [page, setPage] = useState('home')
  const [settings, setSettings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mcnext-settings') || '{}')
    } catch { return {} }
  })
  const [gameRunning, setGameRunning] = useState(false)
  const [serverRunning, setServerRunning] = useState(false)

  useEffect(() => {
    localStorage.setItem('mcnext-settings', JSON.stringify(settings))
  }, [settings])

  // 模块五：沉浸式夜间护眼模式（全局 data-theme 切换）
  useEffect(() => {
    const theme = settings.theme === 'midnight' ? 'midnight' : 'dark'
    document.documentElement.setAttribute('data-theme', theme)
  }, [settings.theme])

  useEffect(() => {
    const api = window.mcnext
    if (!api) return
    api.onGameExit(() => setGameRunning(false))
    api.onServerExit(() => setServerRunning(false))
    api.gameStatus().then(setGameRunning)
    api.serverStatus().then(setServerRunning)
  }, [])

  const pages = {
    home: HomePage, download: DownloadPage, console: ConsolePage,
    server: ServerPage, account: AccountPage, modpack: ModpackPage,
    localjar: LocalJarPage, crash: CrashPage,
    java: JavaManagerPage, lobby: LobbyPage, world: WorldManagerPage,
    skin: SkinPage, mods: ModsPage, settings: SettingsPage
  }
  const Page = pages[page] || HomePage

  return (
    <div className="h-full flex flex-col bg-base-900">
      {!isMobile && <TitleBar />}
      <div className="flex-1 flex min-h-0">
        {!isMobile && (
          <Sidebar
            page={page}
            setPage={setPage}
            gameRunning={gameRunning}
            serverRunning={serverRunning}
          />
        )}
        <main className={`flex-1 min-w-0 overflow-hidden ${isMobile ? 'p-3' : 'p-6'} animate-fade-in`}>
          <Page
            settings={settings}
            setSettings={setSettings}
            gameRunning={gameRunning}
            setGameRunning={setGameRunning}
            serverRunning={serverRunning}
            setServerRunning={setServerRunning}
            goto={setPage}
          />
        </main>
      </div>
      {isMobile && <MobileNav page={page} setPage={setPage} gameRunning={gameRunning} />}
    </div>
  )
}
