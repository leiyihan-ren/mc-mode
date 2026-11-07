import React from 'react'
// 0.6.0：版本号单一数据源，直接取 package.json，杜绝每次发版手工改 UI 字符串
import pkg from '../../package.json'

export default function TitleBar() {
  return (
    <div className="drag-region h-12 flex items-center justify-between px-5 bg-base-800/80 border-b border-white/5 backdrop-blur-xs">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent to-mc-blue flex items-center justify-center text-base-900 font-bold text-sm shadow-glow">
          MC
        </div>
        <span className="font-semibold tracking-wide text-slate-200">MC-Next</span>
        <span className="tag bg-accent/10 text-accent border border-accent/20">v{pkg.version}</span>
      </div>
      <div className="no-drag flex items-center gap-2 text-xs text-slate-500">
        <span className="hidden sm:inline">Electron + React 全生态启动器</span>
      </div>
    </div>
  )
}
