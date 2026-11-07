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
import InstancePage from './pages/InstancePage.jsx'
import ResourceCenterPage from './pages/ResourceCenterPage.jsx'
import MobileNav from './components/MobileNav.jsx'
import BackgroundLayer from './components/BackgroundLayer.jsx'
import LaunchTransition from './components/LaunchTransition.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
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
  const [launchFx, setLaunchFx] = useState(null)

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

  // 0.5.0 模块一：启动过渡动画，返回 Promise 供 HomePage 与真实启动并行等待
  const playLaunchFx = useCallback((version) => {
    setLaunchFx({ version })
    return new Promise(resolve => setTimeout(resolve, 1450))
  }, [])

  const pages = {
    home: HomePage, download: DownloadPage, console: ConsolePage,
    server: ServerPage, account: AccountPage, modpack: ModpackPage,
    localjar: LocalJarPage, crash: CrashPage,
    java: JavaManagerPage, lobby: LobbyPage, world: WorldManagerPage,
    skin: SkinPage, mods: ModsPage, instances: InstancePage,
    resources: ResourceCenterPage, settings: SettingsPage
  }
  const Page = pages[page] || HomePage

  return (
    <div className="app-root">
      <BackgroundLayer config={settings.background} />
      <div className={`app-shell flex flex-col ${launchFx ? 'app-shell-launching' : ''}`}>
        {!isMobile && <TitleBar />}
        <UpdateBanner />
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
              playLaunchFx={playLaunchFx}
            />
          </main>
        </div>
        {isMobile && <MobileNav page={page} setPage={setPage} gameRunning={gameRunning} />}
      </div>
      {launchFx && <LaunchTransition version={launchFx.version} onDone={() => setLaunchFx(null)} />}
    </div>
  )
}
