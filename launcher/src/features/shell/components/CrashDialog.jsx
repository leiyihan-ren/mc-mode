/**
 * CrashDialog.jsx — 0.7.0 模块四：全局致命崩溃弹窗（双端共用）
 *
 * 订阅底层 game:crash 事件（桌面由 guardian.cjs 实时拦截 stderr，
 * 安卓由 NativeCommandRouter 在 JVM 异常退出 / native crash 时上报）。
 * 报告是「人类能看懂」的：发生了什么、命中了什么、该怎么修。
 *
 * 关键约束：崩溃时强制复位 gameRunning，绝不把 UI 留在「启动中」。
 * 纯前端组件，不新增任何 IPC channel，不伪造诊断数据。
 */
import React, { useEffect, useRef, useState } from 'react'
import { api } from '@/services'

const SEV = {
  fatal: { label: '致命', cls: 'bg-mc-red/15 text-mc-red border-mc-red/30' },
  error: { label: '错误', cls: 'bg-mc-red/10 text-mc-red border-mc-red/20' },
  warn: { label: '警告', cls: 'bg-mc-gold/15 text-mc-gold border-mc-gold/30' },
  info: { label: '提示', cls: 'bg-accent/10 text-accent border-accent/30' }
}

export default function CrashDialog({ setGameRunning, goto }) {
  const [report, setReport] = useState(null)
  const [showEvidence, setShowEvidence] = useState(false)
  const [copied, setCopied] = useState(false)
  // 0.9.0 模块一C：双通道去重（主通道 game:crash + Service 层兜底广播）
  const lastRef = useRef({ key: '', at: 0 })
  // 0.9.0 模块二C：复制提示延时器，卸载时清理
  const copiedTimer = useRef(null)

  useEffect(() => {
    // 两条来源：
    //  1) game:crash —— 桌面 CrashGuardian / ipcGuard、Android CrashGuard 主通道
    //  2) mcnext:bridge-fatal —— Service 层对底层 IPC/JNI 致命错误的全局兜底广播
    // 同一份报告可能经两条通道到达，按 code+reason 在 800ms 窗口内去重，只弹一次。
    const showReport = (r) => {
      if (!r || r.ok === true) return
      const key = `${r.code || 'unknown'}|${String(r.reason || '').slice(0, 120)}`
      const now = Date.now()
      if (lastRef.current.key === key && now - lastRef.current.at < 800) return
      lastRef.current = { key, at: now }
      setReport(r)
      setShowEvidence(false)
      setCopied(false)
      // 崩溃必复位：无论进程是否已清，UI 都不能停在「启动中」。
      if (typeof setGameRunning === 'function') setGameRunning(false)
    }

    const offs = []
    if (api.isAvailable()) offs.push(api.onGameCrash(showReport))
    const onBridgeFatal = (e) => showReport(e && e.detail)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('mcnext:bridge-fatal', onBridgeFatal)
    }
    return () => {
      for (const off of offs) { if (typeof off === 'function') off() }
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('mcnext:bridge-fatal', onBridgeFatal)
      }
    }
  }, [setGameRunning])

  if (!report) return null
  const sev = SEV[report.severity] || SEV.fatal
  const suggestions = report.suggestions || []
  const evidence = report.evidence || []

  const copyReport = async () => {
    const text = [
      `MC-Next 崩溃诊断 · ${report.title}`,
      `等级：${sev.label}｜代码：${report.code || '未知'}｜来源：${report.source || 'stream'}`,
      report.reason ? `命中：${report.reason}` : '',
      '',
      '修复建议：',
      ...suggestions.map((s, i) => `  ${i + 1}. ${s}`),
      '',
      '日志证据：',
      ...evidence
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1800)
    } catch { setCopied(false) }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="glass-panel w-full max-w-2xl max-h-[86vh] overflow-y-auto border border-mc-red/25 shadow-2xl">
        {/* 头部：一句话说清发生了什么 */}
        <div className="p-5 pb-4 border-b border-white/10 flex items-start gap-3">
          <div className="text-2xl leading-none mt-0.5">⚠️</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-bold text-slate-100">游戏已异常终止</h2>
              <span className={`tag border ${sev.cls}`}>{sev.label}</span>
              {report.code && <span className="text-[11px] font-mono text-slate-500">{report.code}</span>}
            </div>
            <p className="text-sm text-mc-red mt-1.5 font-medium">{report.title}</p>
            <p className="text-[11px] text-slate-500 mt-1">
              启动器已主动接管并清理进程，不会卡在「启动中」。下面是可读的原因与修复建议。
            </p>
          </div>
          <button className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1" title="关闭" onClick={() => setReport(null)}>×</button>
        </div>

        <div className="p-5 space-y-4">
          {/* 命中原因 */}
          {report.reason && (
            <section>
              <div className="text-xs font-medium text-slate-400 mb-1.5">检测到的致命特征</div>
              <div className="bg-base-900/70 border border-white/10 rounded-lg px-3 py-2 text-[12px] font-mono text-slate-300 break-all">
                {report.reason}
              </div>
            </section>
          )}

          {/* 人类可读的修复建议 */}
          {suggestions.length > 0 && (
            <section>
              <div className="text-xs font-medium text-slate-400 mb-1.5">建议按以下步骤排查</div>
              <ol className="space-y-1.5">
                {suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-slate-300">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-accent/15 text-accent text-[11px] flex items-center justify-center font-mono">{i + 1}</span>
                    <span className="leading-5">{s}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* 折叠的日志证据（不伪造，来自真实 stderr/stdout 环形缓冲） */}
          {evidence.length > 0 && (
            <section>
              <button className="text-xs text-accent hover:underline" onClick={() => setShowEvidence(v => !v)}>
                {showEvidence ? '▾ 收起日志证据' : `▸ 查看 ${evidence.length} 行日志证据`}
              </button>
              {showEvidence && (
                <pre className="mt-2 max-h-48 overflow-auto bg-base-900/70 border border-white/10 rounded-lg p-3 text-[11px] font-mono text-slate-400 whitespace-pre-wrap break-all">
                  {evidence.join('\n')}
                </pre>
              )}
            </section>
          )}
        </div>

        {/* 操作区 */}
        <div className="p-4 border-t border-white/10 flex gap-2 flex-wrap items-center">
          <button className="btn-primary text-sm" onClick={() => setReport(null)}>我知道了</button>
          <button className="btn-ghost text-sm" onClick={copyReport}>{copied ? '已复制' : '复制诊断'}</button>
          {typeof goto === 'function' && (
            <button className="btn-ghost text-sm" onClick={() => { setReport(null); goto('crash') }}>打开崩溃诊断页</button>
          )}
          <span className="ml-auto text-[11px] text-slate-600">
            {report.source === 'exit' ? '异常退出兜底' : '实时拦截'} · {report.stream || 'stderr'}
          </span>
        </div>
      </div>
    </div>
  )
}
