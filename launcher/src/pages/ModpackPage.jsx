import React, { useState, useEffect } from 'react'

const api = () => window.mcnext

/** 模块二：整合包一键安装（Modrinth .mrpack / CurseForge manifest / MultiMC） */
export default function ModpackPage() {
  const [path, setPath] = useState('')
  const [plan, setPlan] = useState(null)
  const [instanceId, setInstanceId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [events, setEvents] = useState([])
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    const off = api()?.onModpackProgress?.(e => {
      setEvents(prev => [...prev.slice(-60), `${e.type}: ${JSON.stringify(e).slice(0, 160)}`])
    })
    return () => off && off()
  }, [])

  const pick = async () => {
    try {
      const p = await api().pickFile(['mrpack', 'zip', 'json'])
      if (!p) return
      setPath(p); setPlan(null); setReport(null); setMsg(null)
      const parsed = await api().modpackParse(p)
      setPlan(parsed)
      setInstanceId(parsed.name ? parsed.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') : 'modpack')
    } catch (e) { setMsg({ ok: false, text: `解析失败：${e.message}` }) }
  }

  const install = async () => {
    if (!plan || !instanceId) return
    setBusy(true); setEvents([]); setReport(null); setMsg(null)
    try {
      const r = await api().modpackInstall({ plan, instanceId, apiKey })
      setReport(r)
      setMsg({ ok: true, text: `安装完成：下载 ${r.downloaded} 个文件，失败 ${r.failed.length} 个，释放覆盖文件 ${r.overrides.length} 个` })
    } catch (e) { setMsg({ ok: false, text: `安装失败：${e.message}` }) }
    finally { setBusy(false) }
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">整合包</h1>
        <p className="text-sm text-slate-500 mt-1">自动解析 Modrinth / CurseForge / MultiMC，并发下载并安装 Forge/Fabric/NeoForge/Quilt 依赖</p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      <section className="glass-panel p-5">
        <button className="btn-primary text-sm" onClick={pick}>选择整合包文件（.mrpack / .zip / .json）</button>
        {path && <div className="text-xs font-mono text-slate-500 mt-3 break-all">{path}</div>}

        {plan && (
          <div className="mt-5 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['名称', plan.name], ['格式', plan.format],
                ['MC 版本', plan.gameVersion], ['文件数', (plan.files || []).length]
              ].map(([k, v]) => (
                <div key={k} className="bg-base-900/60 border border-white/5 rounded-xl px-3 py-2">
                  <div className="text-[10px] text-slate-500">{k}</div>
                  <div className="text-sm font-mono text-slate-200 truncate">{String(v ?? '-')}</div>
                </div>
              ))}
            </div>
            <div className="text-xs text-slate-400">
              加载器：{(plan.loaders || []).map(l => `${l.type}-${l.version}`).join(' / ') || '无（原版）'}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-500">隔离实例 ID
                <input className="block mt-1 bg-base-900/60 border border-white/10 rounded-xl px-3 py-2 text-sm font-mono outline-none focus:border-accent/50"
                       value={instanceId} onChange={e => setInstanceId(e.target.value)} />
              </label>
              {plan.format === 'curse' && (
                <label className="text-xs text-slate-500">CurseForge API Key（仅解析直链用）
                  <input className="block mt-1 bg-base-900/60 border border-white/10 rounded-xl px-3 py-2 text-sm font-mono outline-none focus:border-accent/50"
                         value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="留空则用 MCNEXT_CURSE_API_KEY" />
                </label>
              )}
              <button className="btn-primary text-sm" onClick={install} disabled={busy || !instanceId}>
                {busy ? '安装中…' : '一键安装到隔离实例'}
              </button>
            </div>
          </div>
        )}
      </section>

      {events.length > 0 && (
        <section className="glass-panel p-4">
          <div className="text-xs text-slate-400 mb-2">下载引擎实时事件</div>
          <div className="max-h-40 overflow-y-auto font-mono text-[11px] text-slate-500 space-y-0.5">
            {events.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        </section>
      )}

      {report && (
        <section className="glass-panel p-5">
          <div className="text-sm font-medium text-slate-300 mb-2">安装报告</div>
          <pre className="text-[11px] font-mono text-slate-400 bg-black/30 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap">
{JSON.stringify(report, null, 2)}
          </pre>
          {report.unresolved?.length > 0 && (
            <div className="text-xs text-mc-gold mt-2">
              未解析直链 {report.unresolved.length} 个（CurseForge 需 API Key，不伪造下载链接）
            </div>
          )}
        </section>
      )}
    </div>
  )
}
