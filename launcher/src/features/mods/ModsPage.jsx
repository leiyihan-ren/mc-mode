import { api } from '@/services'
import React, { useCallback, useEffect, useState } from 'react'

/** 模块二（0.4.0）：模组与资源包智能管家
 *  - 真实扫描 mods/.jar 与 .jar.disabled，启用禁用走后端真实 rename
 *  - 缺失前置（如 Fabric API）标红 + 真实官方引导链接
 *  - 光影/材质包一键导入，自动检测 Iris / Oculus / OptiFine
 */
export default function ModsPage() {
  const [instances, setInstances] = useState([])
  const [target, setTarget] = useState('') // '' = 默认游戏目录；否则隔离实例 id
  const [data, setData] = useState(null)
  const [conflicts, setConflicts] = useState(null)
  const [packs, setPacks] = useState(null)
  const [shader, setShader] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const opts = useCallback(() => (target ? { instanceId: target } : {}), [target])

  const refresh = useCallback(async () => {
    try {
      const o = opts()
      const [list, cf, pk, sh] = await Promise.all([
        api.modsList(o),
        api.modsConflicts(o),
        api.modsPacks(o),
        api.modsShaderCheck(o)
      ])
      setData(list); setConflicts(cf); setPacks(pk); setShader(sh)
    } catch (e) { setMsg({ type: 'error', text: `读取失败：${e.message}` }) }
  }, [opts])

  useEffect(() => {
    api.instanceList?.().then(r => setInstances(Array.isArray(r) ? r : [])).catch(() => {})
    refresh()
  }, [refresh])

  const toggle = async (m) => {
    if (busy) return
    setBusy(true); setMsg(null)
    try {
      const r = await api.modsToggle({ ...opts(), file: m.file, enabled: !m.enabled })
      if (r.ok) { setMsg({ type: 'ok', text: `已${m.enabled ? '禁用' : '启用'} ${m.file}` }); await refresh() }
      else setMsg({ type: 'error', text: r.error })
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
    finally { setBusy(false) }
  }

  const importPack = async (kind) => {
    if (busy) return
    try {
      const src = await api.modsPickPack()
      if (!src) return
      setBusy(true); setMsg(null)
      let r = await api.modsImport({ ...opts(), kind, srcPath: src })
      if (!r.ok && r.exists && window.confirm(`${r.error}\n\n是否覆盖同名文件？`)) {
        r = await api.modsImport({ ...opts(), kind, srcPath: src, overwrite: true })
      }
      if (r.ok) {
        setMsg({ type: 'ok', text: `已导入 ${r.name} · SHA-256 ${r.sha256.slice(0, 16)}…` })
        await refresh()
      } else setMsg({ type: 'error', text: r.error })
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
    finally { setBusy(false) }
  }

  const openLink = (url) => api.openExternal(url).catch(() => {})

  const errors = (conflicts?.issues || []).filter(i => i.severity === 'error')
  const warnings = (conflicts?.issues || []).filter(i => i.severity === 'warning')

  return (
    <div className="h-full flex flex-col gap-4 overflow-y-auto">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">模组与资源包管家</h1>
          <p className="text-sm text-slate-500 mt-1">真实解析 jar 内 fabric.mod.json / mods.toml · 缺失前置标红 · 光影材质一键导入</p>
        </div>
        <select
          className="bg-base-800 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent/50"
          value={target} onChange={e => setTarget(e.target.value)}
        >
          <option value="">默认游戏目录</option>
          {instances.map(i => <option key={i.id} value={i.id}>隔离实例 · {i.name || i.id}</option>)}
        </select>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>
          {msg.text}
        </div>
      )}

      {/* 冲突检测 */}
      <section className="glass-panel p-4">
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-sm font-semibold text-slate-200">依赖冲突检测</h2>
          {conflicts && (
            <>
              <span className={`tag ${errors.length ? 'bg-mc-red/15 text-mc-red' : 'bg-mc-green/15 text-mc-green'}`}>
                {errors.length ? `${errors.length} 项错误` : '无阻断错误'}
              </span>
              {warnings.length > 0 && <span className="tag bg-mc-gold/15 text-mc-gold">{warnings.length} 项提示</span>}
              <span className="text-xs text-slate-600 ml-auto">已扫描 {conflicts.scanned} 个启用模组</span>
            </>
          )}
        </div>
        {!conflicts && <div className="text-sm text-slate-500">检测中…</div>}
        {conflicts && errors.length === 0 && warnings.length === 0 && (
          <div className="text-sm text-mc-green">✓ 未检测到缺失前置或加载器混装</div>
        )}
        <div className="space-y-2">
          {conflicts?.issues?.map((i, idx) => (
            <div key={idx} className={`rounded-xl px-3 py-2 text-sm border ${i.severity === 'error' ? 'bg-mc-red/5 border-mc-red/30' : 'bg-mc-gold/5 border-mc-gold/25'}`}>
              <div className={i.severity === 'error' ? 'text-mc-red font-medium' : 'text-mc-gold'}>
                {i.severity === 'error' ? '⛔' : '⚠'} {i.message}
              </div>
              {i.links?.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {i.links.map(l => (
                    <button key={l.id || l.url} className="text-xs text-accent hover:underline" onClick={() => openLink(l.url)}>
                      ↗ {l.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {conflicts?.note && <div className="text-[11px] text-slate-600 mt-2">{conflicts.note}</div>}
      </section>

      {/* 模组列表 */}
      <section className="glass-panel overflow-hidden flex flex-col">
        <div className="px-4 py-3 flex items-center gap-3 border-b border-white/5">
          <h2 className="text-sm font-semibold text-slate-200">本地模组</h2>
          {data && <span className="text-xs text-slate-500">{data.enabledCount} 启用 / {data.disabledCount} 禁用 · {data.gameDir}</span>}
          <button className="btn-ghost text-xs ml-auto" onClick={refresh} disabled={busy}>刷新</button>
        </div>
        <div className="overflow-y-auto max-h-72">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-base-800/95 text-slate-500 text-xs">
              <tr>
                <th className="text-left px-4 py-2 font-medium">模组</th>
                <th className="text-left px-4 py-2 font-medium">版本 / 加载器</th>
                <th className="text-left px-4 py-2 font-medium">依赖</th>
                <th className="text-right px-4 py-2 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {data?.mods?.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-600">mods 目录为空，放入 .jar 模组后点击刷新</td></tr>
              )}
              {data?.mods?.map(m => (
                <tr key={m.file} className="border-t border-white/5 hover:bg-white/[0.02]">
                  <td className="px-4 py-2">
                    <div className={`font-mono text-xs ${m.enabled ? 'text-slate-300' : 'text-slate-600 line-through'}`}>{m.file}</div>
                    <div className="text-xs text-slate-500">{m.name || (m.parseError ? '无法解析元数据' : '—')}</div>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <span className="font-mono text-slate-400">{m.version || '—'}</span>
                    {m.loader && m.loader !== 'unknown' && <span className="tag bg-mc-blue/15 text-mc-blue ml-2">{m.loader}</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {m.depends?.length ? m.depends.map(d => d.id).join(', ') : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      className={`btn text-xs ${m.enabled ? 'btn-ghost' : 'btn-primary'}`}
                      disabled={busy}
                      onClick={() => toggle(m)}
                    >
                      {m.enabled ? '禁用' : '启用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 光影 / 材质包 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[
          { kind: 'shaderpacks', label: '光影包', icon: '✨' },
          { kind: 'resourcepacks', label: '材质包', icon: '🎨' }
        ].map(cfg => (
          <section key={cfg.kind} className="glass-panel p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-200">{cfg.icon} {cfg.label}</h2>
              <span className="text-xs text-slate-500 ml-auto">{packs?.[cfg.kind]?.packs?.length || 0} 个</span>
              <button className="btn-primary text-xs" onClick={() => importPack(cfg.kind)} disabled={busy}>＋ 导入 .zip</button>
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {packs?.[cfg.kind]?.packs?.length === 0 && <div className="text-xs text-slate-600">暂无{cfg.label}</div>}
              {packs?.[cfg.kind]?.packs?.map(p => (
                <div key={p.name} className="text-xs font-mono text-slate-400 truncate px-2 py-1 bg-base-900/40 rounded">
                  {p.name} <span className="text-slate-600">· {(p.size / 1048576).toFixed(1)}MB</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* 光影前置检测 */}
      {shader && (
        <section className={`glass-panel p-4 border ${shader.needed ? 'border-mc-gold/40' : 'border-white/5'}`}>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-slate-200">光影加载器检测</h2>
            <span className={`tag ${shader.needed ? 'bg-mc-gold/15 text-mc-gold' : 'bg-mc-green/15 text-mc-green'}`}>
              {shader.status === 'ok' ? '已就绪' : shader.status === 'no-shaderpacks' ? '未安装光影包' : '需要安装加载器'}
            </span>
          </div>
          {shader.message && <div className={`text-sm ${shader.needed ? 'text-mc-gold' : 'text-slate-400'}`}>{shader.message}</div>}
          {shader.links?.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {shader.links.map(l => (
                <button key={l.id || l.url} className="btn-ghost text-xs" onClick={() => openLink(l.url)}>↗ {l.name}</button>
              ))}
            </div>
          )}
          <div className="text-[11px] text-slate-600 mt-2">光影包须放入 shaderpacks/ 且游戏需由 Iris / Oculus / OptiFine 加载；材质包可直接在游戏内资源包菜单启用。</div>
        </section>
      )}
    </div>
  )
}
