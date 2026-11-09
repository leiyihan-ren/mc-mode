import { api } from '@/services'
import { useInstance } from '@/features/shell/InstanceContext.jsx'
import React, { useState, useEffect, useCallback } from 'react'

/**
 * 0.5.0 模块二：版本 / 实例管理页
 *  - 列出所有隔离实例（真实扫描 mods / saves / config / 占用）
 *  - 一键导出整合包：标准 .mrpack（mods + config + options.txt + 依赖版本），落地本地文件
 *  - 新建 / 删除实例；导出结果给出现实路径、体积、SHA-256、收集明细
 */
export default function InstancePage({ goto }) {
  // 0.9.0 模块一A：当前激活实例 + 一键平滑切换
  const { activeId, switching, error: switchError, version, switchTo } = useInstance()
  const [list, setList] = useState([])
  const [info, setInfo] = useState({})       // id -> info
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [exportResult, setExportResult] = useState(null)
  const [msg, setMsg] = useState(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ id: '', name: '', gameVersion: '1.20.1', loader: 'fabric-0.15.11' })

  const doSwitch = async (id) => {
    setMsg(null)
    const r = await switchTo(id)
    setMsg(r && r.ok
      ? { ok: true, text: `已切换到实例「${id}」，mods / saves / config 已物理隔离` }
      : { ok: false, text: `切换失败：${(r && r.error) || switchError || '未知原因'}` })
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const a = api
      const arr = await a.instanceList()
      setList(arr || [])
      const details = {}
      for (const it of (arr || [])) {
        try { details[it.id] = await a.instanceInfo(it.id) } catch { /* 单个失败不影响列表 */ }
      }
      setInfo(details)
    } catch (e) { setMsg({ ok: false, text: `读取实例失败：${e.message}` }) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh, version])

  const doExport = async (id) => {
    setBusyId(id); setExportResult(null); setMsg(null)
    try {
      const it = list.find(x => x.id === id)
      const r = await api.modpackExport({ instanceId: id, name: it?.name || id })
      if (r.ok) {
        setExportResult(r)
        setMsg({ ok: true, text: `导出成功：${r.collected?.mods ?? 0} 个模组 / ${r.collected?.configFiles ?? 0} 个配置 / ${r.collected?.optionsTxt ? '含' : '无'} options.txt` })
      } else {
        setMsg({ ok: false, text: `导出失败：${r.error}` })
      }
    } catch (e) { setMsg({ ok: false, text: `导出异常：${e.message}` }) }
    finally { setBusyId(null) }
  }

  const doCreate = async () => {
    if (!form.id.trim()) return
    try {
      await api.instanceCreate({
        id: form.id.trim(), name: form.name.trim() || form.id.trim(),
        gameVersion: form.gameVersion.trim(), loader: form.loader.trim() || null
      })
      setCreating(false)
      setForm({ id: '', name: '', gameVersion: '1.20.1', loader: 'fabric-0.15.11' })
      setMsg({ ok: true, text: `已创建实例「${form.id.trim()}」` })
      refresh()
    } catch (e) { setMsg({ ok: false, text: `创建失败：${e.message}` }) }
  }

  const doRemove = async (id) => {
    if (!window.confirm(`确认删除实例「${id}」？（含模组/存档，非空实例会被拒绝）`)) return
    try {
      await api.instanceRemove(id)
      setMsg({ ok: true, text: `已删除实例「${id}」` })
      refresh()
    } catch (e) { setMsg({ ok: false, text: `删除失败：${e.message}` }) }
  }

  const fmtSize = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">版本 / 实例管理</h1>
          <p className="text-sm text-slate-500 mt-1">
            每个实例独立拥有 mods / saves / config。一键导出为标准 <span className="text-accent font-mono">.mrpack</span> 整合包分享给好友
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-slate-500">当前实例：</span>
            {activeId
              ? <span className="tag bg-accent/15 text-accent border border-accent/30 font-mono">📦 {activeId} · 已隔离</span>
              : <span className="tag bg-white/5 text-slate-500">未选择（使用主游戏目录）</span>}
            {switching && <span className="text-accent animate-pulse">切换中…</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost text-sm" onClick={() => goto && goto('modpack')}>前往导入整合包 →</button>
          <button className="btn-ghost text-sm" onClick={refresh}>刷新</button>
          <button className="btn-primary text-sm" onClick={() => setCreating(v => !v)}>{creating ? '取消' : '＋ 新建实例'}</button>
        </div>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      {creating && (
        <section className="glass-panel p-5 border-accent/20">
          <div className="text-sm font-medium text-accent mb-3">新建隔离实例</div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {[
              ['id', '实例 ID（英文/数字）'], ['name', '显示名称'],
              ['gameVersion', 'MC 版本'], ['loader', '加载器（如 fabric-0.15.11）']
            ].map(([k, label]) => (
              <label key={k} className="text-[11px] text-slate-500">{label}
                <input
                  className="block mt-1 w-full bg-base-900/60 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-accent/50"
                  value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button className="btn-primary text-sm" onClick={doCreate} disabled={!form.id.trim()}>创建</button>
            <span className="text-[11px] text-slate-600 self-center">导出依赖 MC 版本与加载器信息，请如实填写</span>
          </div>
        </section>
      )}

      <section className="glass-panel p-5">
        <div className="text-sm font-medium text-slate-300 mb-3">隔离实例（{list.length}）</div>
        {loading && <div className="text-slate-500 text-sm p-3">加载中…</div>}
        {!loading && list.length === 0 && (
          <div className="text-slate-500 text-sm p-3">暂无实例。可在整合包页导入，或点击「新建实例」。</div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {list.map(it => {
            const d = info[it.id] || {}
            const isActive = activeId === it.id
            return (
              <div key={it.id} className={`bg-base-900/50 border rounded-xl p-4 transition-all duration-300 ${isActive ? 'border-accent/50 shadow-[0_0_0_1px_rgba(94,234,212,0.15)]' : 'border-white/5'}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-base-600 to-base-700 border border-white/10 flex items-center justify-center text-lg shrink-0">📦</div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-200 truncate">{it.name || it.id}</div>
                    <div className="text-[11px] font-mono text-slate-500 truncate">{it.id}</div>
                  </div>
                  {isActive ? (
                    <span className="ml-auto tag bg-accent/15 text-accent border border-accent/30 shrink-0">● 当前</span>
                  ) : busyId === it.id ? (
                    <span className="ml-auto text-xs text-accent shrink-0">导出中…</span>
                  ) : (
                    <span className="ml-auto tag bg-white/5 text-slate-500 shrink-0">隔离</span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                  <div className="bg-black/20 rounded-lg py-1.5">
                    <div className="text-sm font-mono text-slate-200">{d.mods ?? '-'}</div>
                    <div className="text-[10px] text-slate-500">模组</div>
                  </div>
                  <div className="bg-black/20 rounded-lg py-1.5">
                    <div className="text-sm font-mono text-slate-200">{d.saves ?? '-'}</div>
                    <div className="text-[10px] text-slate-500">存档</div>
                  </div>
                  <div className="bg-black/20 rounded-lg py-1.5">
                    <div className="text-sm font-mono text-slate-200">{d.bytes != null ? fmtSize(d.bytes) : '-'}</div>
                    <div className="text-[10px] text-slate-500">占用</div>
                  </div>
                </div>
                <div className="text-[11px] text-slate-500 mt-2 font-mono truncate">
                  {it.gameVersion || '未声明版本'}{it.loader ? ` · ${it.loader}` : ''}
                </div>
                {!it.gameVersion && (
                  <div className="text-[11px] text-mc-gold mt-1">⚠ 缺少 MC 版本，导出会被拦截（可在实例 instance.json 补充）</div>
                )}
                <div className="flex gap-2 mt-3 flex-wrap">
                  <button
                    className={`text-xs flex-1 ${isActive ? 'btn-ghost' : 'btn-primary'}`}
                    onClick={() => doSwitch(it.id)}
                    disabled={switching || isActive}
                  >
                    {isActive ? '✓ 使用中' : switching ? '切换中…' : '⇄ 切换到此实例'}
                  </button>
                  <button className="btn-ghost text-xs" onClick={() => doExport(it.id)} disabled={busyId === it.id}>
                    ⬆ 导出
                  </button>
                  <button className="btn-danger text-xs px-3" onClick={() => doRemove(it.id)}>删除</button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {exportResult && exportResult.ok && (
        <section className="glass-panel p-5 border-mc-green/20">
          <div className="text-sm font-medium text-mc-green mb-3">✓ 封装完成 · 标准 Modrinth 整合包</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            {[
              ['格式', exportResult.format], ['文件', exportResult.fileName],
              ['体积', fmtSize(exportResult.size)], ['模组数', exportResult.manifest?.counts?.mods ?? 0]
            ].map(([k, v]) => (
              <div key={k} className="bg-black/25 border border-white/5 rounded-lg px-3 py-2">
                <div className="text-[10px] text-slate-500">{k}</div>
                <div className="text-sm font-mono text-slate-200 truncate">{String(v)}</div>
              </div>
            ))}
          </div>
          <div className="text-[11px] font-mono text-slate-400 break-all">路径：{exportResult.path}</div>
          <div className="text-[11px] font-mono text-slate-500 break-all mt-1">SHA-256：{exportResult.sha256}</div>
          <div className="text-[11px] text-slate-500 mt-2 leading-relaxed">
            依赖：{Object.entries(exportResult.index?.dependencies || {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '无'}。
            本地模组打包在 <span className="font-mono text-accent">overrides/mods</span> 内（自包含、不伪造远程直链），
            好友拖入整合包页即可一键还原。
          </div>
        </section>
      )}
    </div>
  )
}
