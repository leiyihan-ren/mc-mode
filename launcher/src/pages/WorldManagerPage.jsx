import React, { useEffect, useState, useCallback } from 'react'

/** 模块三：本地世界（存档）智能管家 */
export default function WorldManagerPage({ settings }) {
  const [gameDir, setGameDir] = useState(settings?.gameDir || '')
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [backups, setBackups] = useState([])
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setMsg(null)
    try {
      const r = await window.mcnext.worldList(gameDir || undefined)
      setList(r)
      if (r.ok && r.worlds.length) {
        const w = r.worlds[0]
        openWorld(w)
      } else { setSelected(null); setDetail(null); setBackups([]) }
    } catch (e) { setMsg({ type: 'error', text: `扫描失败: ${e.message}` }) }
  }, [gameDir])

  useEffect(() => { refresh() }, [refresh])

  const pickDir = async () => {
    try {
      const p = await window.mcnext.pickDir()
      if (p) { setGameDir(p); setSettings({ ...settings, gameDir: p }) }
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }

  const openWorld = async (w) => {
    setSelected(w)
    setMsg(null)
    try {
      const d = await window.mcnext.worldInspect(w.dir, gameDir || undefined)
      setDetail(d)
      const bs = await window.mcnext.worldBackups(undefined, w.dirName)
      setBackups(bs)
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }

  const doBackup = async () => {
    if (!selected) return
    setBusy(true); setMsg(null)
    try {
      const r = await window.mcnext.worldBackup(gameDir || undefined, selected.dirName, {})
      if (r.ok) {
        setMsg({ type: 'ok', text: `✓ 已备份 ${selected.name}（共 ${r.total} 份历史）` })
        const bs = await window.mcnext.worldBackups(undefined, selected.dirName)
        setBackups(bs)
      } else setMsg({ type: 'error', text: r.error })
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
    setBusy(false)
  }

  const doRestore = async (zipPath) => {
    if (!selected) return
    if (!confirm(`确定回滚「${selected.name}」到该备份？当前状态会自动生成 pre-restore 快照。`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await window.mcnext.worldRestore(gameDir || undefined, selected.dirName, zipPath, undefined)
      if (r.ok) { setMsg({ type: 'ok', text: `✓ 已回滚，pre-restore 快照：${r.preRestoreBackup}` }); openWorld(selected) }
      else setMsg({ type: 'error', text: r.error })
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
    setBusy(false)
  }

  const fmtSize = (b) => b == null ? '—' : `${(b / 1048576).toFixed(1)} MB`

  return (
    <div className="h-full flex flex-col gap-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">本地世界（存档）智能管家</h1>
          <p className="text-sm text-slate-500 mt-1">扫描 saves 目录，读取游玩时长 / 版本 / 模组，一键备份与回滚（保留最近 5 份）</p>
        </div>
        <button className="btn-ghost text-sm" onClick={pickDir}>选择 .minecraft 目录</button>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      <div className="flex items-center gap-2 text-xs text-slate-500 px-1">
        <span>游戏目录</span>
        <span className="font-mono text-slate-400 break-all">{gameDir || '~/.mc-next/game（默认）'}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 min-h-0 flex-1">
        {/* 世界列表 */}
        <div className="glass-panel flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 text-sm font-medium text-slate-400">世界（{list?.worlds?.length || 0}）</div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {list && !list.ok && <div className="text-sm text-slate-500 p-3">{list.error}</div>}
            {list?.ok && list.worlds.length === 0 && <div className="text-sm text-slate-500 p-3">未找到存档，请确认游戏目录是否正确</div>}
            {list?.ok && list.worlds.map(w => (
              <div key={w.dir} onClick={() => openWorld(w)}
                className={`px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${selected?.dir === w.dir ? 'bg-accent/15 text-accent border border-accent/25' : 'text-slate-400 hover:bg-white/5'}`}>
                <div className="font-medium">{w.name}</div>
                <div className="text-[10px] text-slate-600">{w.version || '未知版本'} · {w.playTimeHuman || w.gameTimeHuman}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 详情 */}
        <div className="glass-panel p-6 flex flex-col gap-3 overflow-y-auto">
          <div className="text-sm font-medium text-slate-300">世界详情</div>
          {!detail && <div className="text-sm text-slate-500">选择左侧某个世界查看详情</div>}
          {detail && (
            <div className="space-y-2 text-sm">
              {detail.error && <div className="text-mc-red text-xs">{detail.error}</div>}
              <Row k="名称" v={detail.name} />
              <Row k="种子" v={detail.seed ?? '—'} mono />
              <Row k="版本" v={`${detail.version || '未知'}${detail.versionSeries ? `（${detail.versionSeries}）` : ''}`} />
              <Row k="游戏类型" v={`${detail.gameType || '—'}${detail.hardcore ? ' · 极限' : ''}`} />
              <Row k="真实游玩时长" v={detail.playTimeHuman || '无统计'} />
              <Row k="时长来源" v={detail.playTimeNote || ''} hint />
              <Row k="世界内时间" v={detail.gameTimeHuman || '—'} />
              <Row k="最近游玩" v={detail.lastPlayedIso ? detail.lastPlayedIso.slice(0, 19).replace('T', ' ') : '—'} />
              <Row k="模组数" v={detail.modCount || 0} />
              <Row k="大小" v={fmtSize(detail.sizeBytes)} />
              {detail.mods?.length > 0 && (
                <div>
                  <div className="text-xs text-slate-500 mb-1">已装模组</div>
                  <div className="text-xs text-slate-400 max-h-32 overflow-y-auto space-y-0.5">
                    {detail.mods.slice(0, 30).map((m, i) => <div key={i} className="truncate">{m.name}</div>)}
                  </div>
                </div>
              )}
              <button className="btn-primary text-sm mt-2 w-full" disabled={busy} onClick={doBackup}>📦 一键备份当前世界</button>
            </div>
          )}
        </div>

        {/* 备份 */}
        <div className="glass-panel p-6 flex flex-col gap-3 overflow-y-auto">
          <div className="text-sm font-medium text-slate-300">历史备份（保留最近 5 份）</div>
          {!selected && <div className="text-sm text-slate-500">选择一个世界以查看备份</div>}
          {selected && backups.length === 0 && <div className="text-sm text-slate-500">尚无备份，点击左侧「一键备份」</div>}
          <div className="space-y-2">
            {backups.map((b, i) => (
              <div key={i} className="bg-base-900/50 rounded-xl px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-200 font-mono">{b.name}</div>
                  <div className="text-[10px] text-slate-600">{fmtSize(b.size)}{b.meta?.sha256 ? ` · sha256:${b.meta.sha256.slice(0, 8)}` : ''}</div>
                </div>
                <button className="btn-ghost text-xs shrink-0" disabled={busy} onClick={() => doRestore(b.file)}>回滚</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v, mono, hint }) {
  return (
    <div className={hint ? 'bg-base-900/40 rounded-lg px-3 py-2' : ''}>
      <div className="text-xs text-slate-500">{k}</div>
      <div className={`text-sm text-slate-300 ${mono ? 'font-mono break-all' : ''} ${hint ? 'text-[11px] text-slate-500 leading-relaxed' : ''}`}>{v}</div>
    </div>
  )
}
