import React, { useState, useEffect, useCallback } from 'react'
import Sidebar from '@/features/shell/components/Sidebar.jsx'
import TitleBar from '@/features/shell/components/TitleBar.jsx'
import HomePage from '@/features/launcher/HomePage.jsx'
import DownloadPage from '@/features/launcher/DownloadPage.jsx'
import ConsolePage from '@/features/launcher/ConsolePage.jsx'
import ServerPage from '@/features/server/ServerPage.jsx'
import SettingsPage from '@/features/settings/SettingsPage.jsx'
import AccountPage from '@/features/account/AccountPage.jsx'
import ModpackPage from '@/features/mods/ModpackPage.jsx'
import LocalJarPage from '@/features/launcher/LocalJarPage.jsx'
import CrashPage from '@/features/crash/CrashPage.jsx'
import JavaManagerPage from '@/features/settings/JavaManagerPage.jsx'
import LobbyPage from '@/features/server/LobbyPage.jsx'
import WorldManagerPage from '@/features/world/WorldManagerPage.jsx'
import SkinPage from '@/features/account/SkinPage.jsx'
import ModsPage from '@/features/mods/ModsPage.jsx'
import InstancePage from '@/features/launcher/InstancePage.jsx'
import ResourceCenterPage from '@/features/mods/ResourceCenterPage.jsx'
import MobileNav from '@/features/shell/components/MobileNav.jsx'
import BackgroundLayer from '@/features/shell/components/BackgroundLayer.jsx'
import LaunchTransition from '@/features/shell/components/LaunchTransition.jsx'
import UpdateBanner from '@/features/shell/components/UpdateBanner.jsx'
import CrashDialog from '@/features/shell/components/CrashDialog.jsx'
import { InstanceProvider, useInstance } from '@/features/shell/InstanceContext.jsx'
import { api, isMobile, createSubscriptionSet } from '@/services'
export default function App() {
  return (
    <InstanceProvider>
      <AppShell />
    </InstanceProvider>
  )
}

function AppShell() {
  const { switching } = useInstance()
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
    if (!api.isAvailable()) return
    // 0.9.0 模块二C：订阅必须随组件卸载注销，杜绝反复挂载累积监听器
    const subs = createSubscriptionSet()
    subs.add(api.onGameExit(() => setGameRunning(false)))
    subs.add(api.onServerExit(() => setServerRunning(false)))
    api.gameStatus().then(setGameRunning)
    api.serverStatus().then(setServerRunning)
    return () => subs.disposeAll()
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
      <div className={`app-shell flex flex-col ${launchFx ? 'app-shell-launching' : ''} ${switching ? 'instance-switching' : ''}`}>
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
      {/* 0.7.0 模块四：全局崩溃弹窗，崩溃时强制复位 gameRunning，绝不卡在「启动中」 */}
      <CrashDialog setGameRunning={setGameRunning} goto={setPage} />
    </div>
  )
}
