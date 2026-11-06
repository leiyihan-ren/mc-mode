import React from 'react'

const TABS = [
  { id: 'home', icon: '🚀', label: '启动' },
  { id: 'download', icon: '⬇️', label: '下载' },
  { id: 'console', icon: '🖥️', label: '控制台' },
  { id: 'server', icon: '🛠️', label: '服务端' },
  { id: 'settings', icon: '⚙️', label: '设置' }
]

/** 移动端底部导航（APK 模式） */
export default function MobileNav({ page, setPage, gameRunning }) {
  return (
    <nav className="shrink-0 flex border-t border-white/10 bg-base-800/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)]">
      {TABS.map(t => (
        <button
          key={t.id}
          onClick={() => setPage(t.id)}
          className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] transition-colors relative ${
            page === t.id ? 'text-accent' : 'text-slate-500'
          }`}
        >
          <span className="text-lg leading-none">{t.icon}</span>
          {t.label}
          {t.id === 'home' && gameRunning && (
            <span className="absolute top-2 right-1/2 translate-x-4 w-1.5 h-1.5 rounded-full bg-mc-green animate-pulse" />
          )}
        </button>
      ))}
    </nav>
  )
}
