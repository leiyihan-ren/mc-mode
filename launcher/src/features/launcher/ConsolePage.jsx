import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { api, isMobile, remoteApi, appendBounded, renderWindow, createSubscriptionSet, BUFFER_LIMITS } from '@/services'
import PerfRadar from '@/features/launcher/components/PerfRadar.jsx'

const LEVEL_CLASS = {
  info: 'log-info',
  warn: 'log-warn',
  error: 'log-error',
  success: 'log-success',
  normal: 'text-slate-300'
}

export default function ConsolePage({ gameRunning, serverRunning }) {
  const [tab, setTab] = useState('game')
  const [lines, setLines] = useState({ game: [], server: [] })
  const [autoscroll, setAutoscroll] = useState(true)
  const [search, setSearch] = useState('')
  const [cmd, setCmd] = useState('')
  const [colored, setColored] = useState(true)
  const [html, setHtml] = useState([])
  const boxRef = useRef(null)

  useEffect(() => {
    if (isMobile) {
      // 移动端：轮询 PC 端日志缓冲
      let lastLen = 0
      const poll = async () => {
        try {
          const r = await remoteApi.logs()
          if (r.ok && r.logs.length !== lastLen) {
            lastLen = r.logs.length
            const game = [], server = []
            for (const l of r.logs) (l.text.includes('[Server]') || /Done|Stopping/.test(l.text) ? server : game).push(l)
            setLines({
              game: appendBounded([], game, BUFFER_LIMITS.LOG_LINES),
              server: appendBounded([], server, BUFFER_LIMITS.LOG_LINES)
            })
          }
        } catch { /* 静默重试 */ }
      }
      poll()
      const iv = setInterval(poll, 2000)
      return () => clearInterval(iv)
    }
    // 0.9.0 模块二C：桌面分支订阅必须随卸载注销（此前缺 cleanup，反复进出控制台会累积监听器）
    const subs = createSubscriptionSet()
    const onGame = l => setLines(p => ({ ...p, game: appendBounded(p.game, l, BUFFER_LIMITS.LOG_LINES) }))
    const onServer = l => setLines(p => ({ ...p, server: appendBounded(p.server, l, BUFFER_LIMITS.LOG_LINES) }))
    subs.add(api.onGameLog(onGame))
    subs.add(api.onServerLog(onServer))
    return () => subs.disposeAll()
  }, [])

  useEffect(() => {
    if (autoscroll && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight
    }
  }, [lines, autoscroll, tab])

  const activeLines = lines[tab]
  // 0.9.0 模块二C：useMemo 保持引用稳定，避免渲染窗口数组每次 render 变化触发高亮 effect 循环
  const filtered = useMemo(
    () => search ? activeLines.filter(l => l.text.toLowerCase().includes(search.toLowerCase())) : activeLines,
    [activeLines, search]
  )
  // 日志区 DOM 节点数恒有上界：长挂机高频日志不会让列表无限增长
  const rendered = useMemo(() => renderWindow(filtered, BUFFER_LIMITS.RENDER_WINDOW), [filtered])

  // 模块三：把真实日志行交给引擎做 ANSI→HTML / 级别着色 / XSS 转义（批量，避免逐行 IPC）
  useEffect(() => {
    if (!colored || isMobile || !api?.consoleHighlightBatch) { setHtml([]); return }
    const src = renderWindow(rendered, BUFFER_LIMITS.HIGHLIGHT_BATCH).map(l => l.text)
    let alive = true
    api.consoleHighlightBatch(src).then(r => { if (alive) setHtml(r || []) }).catch(() => {})
    return () => { alive = false }
  }, [rendered, colored, tab])
  const colorFrom = Math.max(0, rendered.length - BUFFER_LIMITS.HIGHLIGHT_BATCH)

  const handleExport = useCallback(() => {
    const text = activeLines.map(l => l.text).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `mcnext-${tab}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [activeLines, tab])

  const sendCmd = useCallback(() => {
    if (!cmd.trim()) return
    if (isMobile) {
      remoteApi.command(cmd.trim(), tab === 'server').then(r => {
        if (!r.ok) setLines(p => ({ ...p, [tab]: appendBounded(p[tab], { level: 'error', text: `[MC-Next] ${r.error}` }, BUFFER_LIMITS.LOG_LINES) }))
      }).catch(e => setLines(p => ({ ...p, [tab]: appendBounded(p[tab], { level: 'error', text: `[MC-Next] ${e.message}` }, BUFFER_LIMITS.LOG_LINES) })))
      setCmd('')
      return
    }
    if (tab === 'server') api.serverCommand(cmd.trim())
    setCmd('')
  }, [cmd, tab])

  const counts = {
    error: activeLines.filter(l => l.level === 'error').length,
    warn: activeLines.filter(l => l.level === 'warn').length
  }

  return (
    <div className="h-full flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">控制台</h1>
          <p className="text-sm text-slate-500 mt-1">实时日志捕获 · 颜色高亮 · 搜索过滤 · 一键导出</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex glass-panel p-1">
            <button
              className={`btn text-xs ${tab === 'game' ? 'btn-primary' : 'btn-ghost border-transparent bg-transparent'}`}
              onClick={() => setTab('game')}
            >
              游戏 {gameRunning && <span className="ml-1 w-1.5 h-1.5 inline-block rounded-full bg-mc-green animate-pulse-soft" />}
            </button>
            <button
              className={`btn text-xs ${tab === 'server' ? 'btn-primary' : 'btn-ghost border-transparent bg-transparent'}`}
              onClick={() => setTab('server')}
            >
              服务端 {serverRunning && <span className="ml-1 w-1.5 h-1.5 inline-block rounded-full bg-mc-green animate-pulse-soft" />}
            </button>
          </div>
        </div>
      </header>

      {/* 0.6.0 模块三：JVM 性能小雷达（真实 GC 日志 + /proc RSS，桌面端常驻） */}
      {!isMobile && <PerfRadar />}

      {/* 工具栏 */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          className="bg-base-800 border border-white/10 rounded-xl px-4 py-1.5 text-sm w-72 outline-none focus:border-accent/50"
          placeholder="🔍 搜索日志内容…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={autoscroll} onChange={e => setAutoscroll(e.target.checked)} className="accent-accent" />
          自动滚屏
        </label>
        {!isMobile && (
          <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
            <input type="checkbox" checked={colored} onChange={e => setColored(e.target.checked)} className="accent-accent" />
            ANSI 彩色高亮
          </label>
        )}
        <div className="flex items-center gap-2 text-xs">
          <span className="tag bg-mc-red/15 text-mc-red">ERROR {counts.error}</span>
          <span className="tag bg-mc-gold/15 text-mc-gold">WARN {counts.warn}</span>
          <span className="tag bg-white/5 text-slate-500" title={`缓冲上限 ${BUFFER_LIMITS.LOG_LINES} 行，渲染窗口 ${BUFFER_LIMITS.RENDER_WINDOW} 行`}>共 {activeLines.length} 行 · 显示 {rendered.length}</span>
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn-ghost text-xs" onClick={() => setLines(p => ({ ...p, [tab]: [] }))}>清空</button>
          <button className="btn-ghost text-xs" onClick={handleExport}>导出日志</button>
        </div>
      </div>

      {/* 日志区 */}
      <div
        ref={boxRef}
        className="flex-1 glass-panel overflow-y-auto py-2 font-mono"
      >
        {rendered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 text-sm">
            {activeLines.length === 0 ? '暂无日志，启动游戏或服务端后在此查看' : '没有匹配的日志行'}
          </div>
        ) : (
          rendered.map((l, i) => {
            const h = colored && i >= colorFrom ? html[i - colorFrom] : null
            return h
              ? <div key={i} dangerouslySetInnerHTML={{ __html: h }} />
              : <div key={i} className={`log-line ${LEVEL_CLASS[l.level] || 'text-slate-300'}`}>{l.text}</div>
          })
        )}
      </div>

      {/* 命令输入（服务端） */}
      {tab === 'server' && (
        <div className="flex gap-2">
          <input
            className="flex-1 bg-base-800 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
            placeholder="输入服务端命令，如 say hello / stop"
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendCmd()}
          />
          <button className="btn-primary text-sm" onClick={sendCmd} disabled={!serverRunning}>发送</button>
        </div>
      )}
    </div>
  )
}
