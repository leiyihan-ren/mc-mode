import React from 'react'

const NAV = [
  { id: 'home', label: '游戏启动', icon: '🎮' },
  { id: 'download', label: '下载中心', icon: '⬇️' },
  { id: 'account', label: '账号中心', icon: '🔑' },
  { id: 'skin', label: '皮肤外观', icon: '🪪' },
  { id: 'modpack', label: '整合包', icon: '📦' },
  { id: 'localjar', label: '本地 Jar', icon: '🧬' },
  { id: 'java', label: 'Java 管家', icon: '☕' },
  { id: 'lobby', label: '联机大厅', icon: '🌐' },
  { id: 'world', label: '世界管家', icon: '🌍' },
  { id: 'console', label: '控制台', icon: '📟' },
  { id: 'server', label: '服务端部署', icon: '🖥️' },
  { id: 'crash', label: '崩溃诊断', icon: '🩺' },
  { id: 'settings', label: '设置', icon: '⚙️' }
]

export default function Sidebar({ page, setPage, gameRunning, serverRunning }) {
  return (
    <aside className="w-56 shrink-0 flex flex-col border-r border-white/5 bg-base-800/50 p-4 gap-1">
      <nav className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1">
        {NAV.map(item => (
          <div
            key={item.id}
            className={`nav-item ${page === item.id ? 'nav-item-active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="text-lg">{item.icon}</span>
            <span className="text-sm font-medium">{item.label}</span>
            {item.id === 'console' && (gameRunning || serverRunning) && (
              <span className="ml-auto w-2 h-2 rounded-full bg-mc-green animate-pulse-soft" />
            )}
          </div>
        ))}
      </nav>
      <div className="mt-auto glass-panel p-4">
        <div className="text-xs text-slate-500 mb-1">运行状态</div>
        <div className="flex items-center gap-2 text-sm">
          <span className={`w-2 h-2 rounded-full ${gameRunning ? 'bg-mc-green animate-pulse-soft' : 'bg-slate-600'}`} />
          <span className="text-slate-300">游戏</span>
          <span className={`ml-auto tag ${gameRunning ? 'bg-mc-green/15 text-mc-green' : 'bg-white/5 text-slate-500'}`}>
            {gameRunning ? '运行中' : '空闲'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm mt-2">
          <span className={`w-2 h-2 rounded-full ${serverRunning ? 'bg-mc-green animate-pulse-soft' : 'bg-slate-600'}`} />
          <span className="text-slate-300">服务端</span>
          <span className={`ml-auto tag ${serverRunning ? 'bg-mc-green/15 text-mc-green' : 'bg-white/5 text-slate-500'}`}>
            {serverRunning ? '运行中' : '空闲'}
          </span>
        </div>
      </div>
    </aside>
  )
}
