import React, { useState, useEffect, useRef } from 'react'

const api = () => window.mcnext
const MAX_DROP_BYTES = 200 * 1024 * 1024 // 拖拽上限 200MB，超过提示用「选择文件」

/** ArrayBuffer → base64（分块，避免大文件 String.fromCharCode 爆栈） */
function arrayBufferToBase64(buf) {
  const u8 = new Uint8Array(buf)
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH))
  }
  return btoa(s)
}

/** 模块二：整合包一键导入（拖拽 / 选择文件）+ 依赖预检拦截 */
export default function ModpackPage() {
  const [path, setPath] = useState('')
  const [plan, setPlan] = useState(null)
  const [describe, setDescribe] = useState(null)
  const [instanceId, setInstanceId] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [events, setEvents] = useState([])
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [force, setForce] = useState(false)
  const [msg, setMsg] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    const off = api()?.onModpackProgress?.(e => {
      setEvents(prev => [...prev.slice(-60), `${e.type}: ${JSON.stringify(e).slice(0, 160)}`])
    })
    return () => off && off()
  }, [])

  const adoptPlan = (parsed, describeObj, label) => {
    setPlan(parsed)
    setDescribe(describeObj || { preflight: null })
    setReport(null)
    setMsg(null)
    setForce(false)
    setPath(label || '')
    setInstanceId(parsed.name ? parsed.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') : 'modpack')
    if (describeObj?.preflight?.blocked) {
      setMsg({ ok: false, text: `预检拦截：${describeObj.preflight.errorCount} 项依赖问题，请查看下方拦截详情（未安装、未创建实例）` })
    }
  }

  const pick = async () => {
    try {
      const p = await api().pickFile(['mrpack', 'zip', 'json'])
      if (!p) return
      const parsed = await api().modpackParse(p)
      const d = await api().modpackDescribe(parsed)
      adoptPlan(parsed, d.ok ? d : null, p)
    } catch (e) { setMsg({ ok: false, text: `解析失败：${e.message}` }) }
  }

  const handleFile = async (file) => {
    if (!file) return
    setBusy(true); setMsg(null)
    try {
      if (file.size > MAX_DROP_BYTES) throw new Error(`文件 ${(file.size / 1048576).toFixed(0)}MB 超过 200MB 拖拽上限，请用「选择整合包文件」`)
      const b64 = arrayBufferToBase64(await file.arrayBuffer())
      const r = await api().modpackParseBuffer(b64)
      if (!r.ok) throw new Error(r.error)
      adoptPlan(r.plan, r.describe, `${file.name}（拖拽导入）`)
    } catch (e) { setMsg({ ok: false, text: `导入失败：${e.message}` }) }
    finally { setBusy(false); setDragOver(false) }
  }

  const onDrop = (e) => {
    e.preventDefault(); setDragOver(false)
    handleFile(e.dataTransfer?.files?.[0])
  }

  const install = async () => {
    if (!plan || !instanceId) return
    setBusy(true); setEvents([]); setReport(null); setMsg(null)
    try {
      const r = await api().modpackInstall({ plan, instanceId, apiKey, force })
      if (r.blocked) {
        setMsg({ ok: false, text: `已拦截：${r.error}` })
        setDescribe(d => ({ ...(d || {}), preflight: r.preflight }))
        return
      }
      setReport(r)
      setMsg({ ok: true, text: `安装完成：下载 ${r.downloaded} 个文件，失败 ${(r.failed || []).length} 个，释放覆盖文件 ${(r.overrides || []).length} 个` })
    } catch (e) { setMsg({ ok: false, text: `安装失败：${e.message}` }) }
    finally { setBusy(false) }
  }

  const pf = describe?.preflight
  const blocked = !!(pf && pf.blocked) && !force
  const openLink = (url) => { try { api().openExternal(url) } catch { /* 忽略 */ } }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">整合包 · 一键导入</h1>
        <p className="text-sm text-slate-500 mt-1">
          拖入或选择 Modrinth <span className="font-mono text-accent">.mrpack</span> / CurseForge / MultiMC 整合包，自动解析 Forge/Fabric 依赖、下载模组并创建隔离实例
        </p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      {/* 拖拽热区 */}
      <section
        className={`drop-zone glass-panel p-6 border-2 border-dashed text-center ${dragOver ? 'drop-zone-active' : 'border-white/10'}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={e => { e.preventDefault(); setDragOver(false) }}
        onDrop={onDrop}
      >
        <div className="text-3xl mb-2">📥</div>
        <div className="text-sm text-slate-300">把整合包拖到这里，或</div>
        <button className="btn-primary text-sm mt-3" onClick={pick} disabled={busy}>选择整合包文件（.mrpack / .zip / .json）</button>
        <input
          ref={fileInputRef} type="file" accept=".mrpack,.zip,.json" className="hidden"
          onChange={e => handleFile(e.target.files?.[0])}
        />
        <div className="text-[11px] text-slate-600 mt-3">支持标准 Modrinth / CurseForge / MultiMC；导入前自动做依赖预检，缺失前置 API 会明确拦截</div>
        {path && <div className="text-xs font-mono text-slate-500 mt-3 break-all">已载入：{path}</div>}
      </section>

      {/* 依赖预检拦截面板（模块三：明确 UI 报错，不崩溃） */}
      {plan && pf && (
        <section className={`glass-panel p-5 border ${pf.blocked ? 'border-mc-red/40' : 'border-mc-green/25'}`}>
          <div className={`text-sm font-medium mb-1 ${pf.blocked ? 'text-mc-red' : 'text-mc-green'}`}>
            {pf.blocked ? `⛔ 已拦截导入 · ${pf.errorCount} 项阻断问题` : `✓ 依赖预检通过 · 扫描 ${pf.scanned} 个内嵌模组`}
          </div>
          <p className={`text-xs leading-relaxed mb-3 ${pf.blocked ? 'text-slate-400' : 'text-slate-500'}`}>{pf.summary}</p>
          {pf.issues && pf.issues.length > 0 && (
            <div className="space-y-2">
              {pf.issues.map((issue, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 text-xs border ${
                  issue.severity === 'error' ? 'border-mc-red/30 bg-mc-red/5 text-mc-red' : 'border-mc-gold/25 bg-mc-gold/5 text-mc-gold'
                }`}>
                  <div>{issue.severity === 'error' ? '✗' : '⚠'} {issue.message}</div>
                  {issue.links && issue.links.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {issue.links.map(l => (
                        <button key={l.id || l.url} className="underline text-accent text-[11px]" onClick={() => openLink(l.url)}>
                          {l.name} ↗
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {pf.blocked && (
            <label className="flex items-center gap-2 mt-3 text-[11px] text-slate-500 cursor-pointer select-none">
              <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} className="accent-accent" />
              我已知晓风险，仍要强制安装（不推荐，游戏可能无法启动）
            </label>
          )}
        </section>
      )}

      {plan && (
        <section className="glass-panel p-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              ['名称', plan.name], ['格式', plan.format],
              ['MC 版本', plan.gameVersion || '未声明'], ['文件数', (plan.files || []).length]
            ].map(([k, v]) => (
              <div key={k} className="bg-base-900/60 border border-white/5 rounded-xl px-3 py-2">
                <div className="text-[10px] text-slate-500">{k}</div>
                <div className="text-sm font-mono text-slate-200 truncate">{String(v ?? '-')}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-slate-400 mt-3">
            加载器：{(plan.loaders || []).map(l => `${l.type}-${l.version}`).join(' / ') || '无（原版）'}
            {describe?.overrideJarCount ? ` · 内嵌模组 ${describe.overrideJarCount} 个` : ''}
            {describe?.unresolved ? ` · 待解析直链 ${describe.unresolved} 个` : ''}
          </div>
          <div className="flex flex-wrap items-end gap-2 mt-3">
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
            <button className={`text-sm ${blocked ? 'btn-ghost' : 'btn-primary'}`} onClick={install} disabled={busy || !instanceId}>
              {busy ? '安装中…' : blocked ? '⛔ 依赖未满足（已禁用）' : force ? '⚠ 强制安装' : '一键安装到隔离实例'}
            </button>
          </div>
        </section>
      )}

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
