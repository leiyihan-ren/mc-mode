import { api } from '@/services'
import React, { useState, useEffect } from 'react'
import { openDownload } from '@/lib/release.js'

const TYPES = [
  { id: 'mod', label: '模组', icon: '🧩' },
  { id: 'shader', label: '光影', icon: '✨' },
  { id: 'modpack', label: '整合包', icon: '📦' },
  { id: 'resourcepack', label: '资源包', icon: '🎨' }
]
const LOADERS = [
  { id: '', label: '不限加载器' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' },
  { id: 'quilt', label: 'Quilt' }
]
const DIR_HINT = { mod: 'mods/', shader: 'shaderpacks/', resourcepack: 'resourcepacks/', modpack: 'modpacks/' }

/**
 * 0.6.0 模块四：Modrinth 在线资源中心。
 * 搜索/版本/依赖全部走真实 api.modrinth.com v2；一键安装下载后 sha512 校验，
 * 自动把 required 依赖一起装进对应目录。无网络时明确报错，不伪造任何搜索结果。
 */
export default function ResourceCenterPage({ settings }) {
  const [query, setQuery] = useState('')
  const [projectType, setProjectType] = useState('mod')
  const [mcVersion, setMcVersion] = useState(settings?.mcVersion || '1.21.1')
  const [loader, setLoader] = useState('fabric')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  const [installing, setInstalling] = useState(null)
  const [msg, setMsg] = useState(null)
  const [progress, setProgress] = useState(null)
  const [lastInstall, setLastInstall] = useState(null)

  useEffect(() => {
    const a = api
    if (!a || typeof a.onModrinthProgress !== 'function') return
    const off = a.onModrinthProgress(p => setProgress(p))
    return () => { try { off && off() } catch { /* noop */ } }
  }, [])

  const search = async (e) => {
    e && e.preventDefault()
    setBusy(true); setMsg(null); setLastInstall(null)
    try {
      const a = api
      if (!a || typeof a.modrinthSearch !== 'function') throw new Error('当前环境不支持 Modrinth 资源中心')
      const r = await a.modrinthSearch({ query, projectType, mcVersion, loader, limit: 20 })
      setResults(r)
      if (!r.hits.length) setMsg({ ok: true, text: '没有匹配结果，可尝试更换关键词或放宽 MC 版本 / 加载器筛选' })
    } catch (err) {
      setResults(null)
      setMsg({ ok: false, text: `搜索失败：${err.message}。沙盒 / 离线环境无法访问 api.modrinth.com 时，本页不会伪造搜索结果。` })
    } finally { setBusy(false) }
  }

  const install = async (hit) => {
    setInstalling(hit.projectId); setMsg(null); setProgress(null); setLastInstall(null)
    try {
      const a = api
      const v = await a.modrinthVersions({ projectId: hit.projectId, mcVersion, loader })
      if (!v.selected) throw new Error('未找到匹配当前 MC 版本 / 加载器的版本')
      const r = await a.modrinthInstall({
        project: hit,
        version: v.selected,
        projectType: hit.projectType,
        mcVersion, loader,
        instanceId: settings?.activeInstanceId || undefined
      })
      setLastInstall(r)
      if (r.ok) {
        setMsg({ ok: true, text: `✓ 已安装 ${r.installed.length} 个文件到 ${DIR_HINT[hit.projectType]}（含 ${r.installed.filter(x => x.dependency).length} 个自动补全依赖）` })
      } else {
        setMsg({
          ok: false,
          text: `部分完成：已落地 ${r.installed.length} 个文件；缺失依赖 ${r.missing.length} 个、失败 ${r.failures.length} 个。${r.failures.map(f => f.error).join('；')}`
        })
      }
    } catch (err) {
      setMsg({ ok: false, text: `安装失败：${err.message}` })
    } finally { setInstalling(null) }
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">🧭 资源中心 · Modrinth</h1>
        <p className="text-sm text-slate-500 mt-1">
          真实 Modrinth v2 API · 模组 / 光影 / 整合包 / 资源包 · 一键下载并自动补全前置依赖
        </p>
      </header>

      <form className="glass-panel p-4 flex flex-wrap gap-3 items-end" onSubmit={search}>
        <div className="flex-1 min-w-[220px]">
          <div className="text-[11px] text-slate-500 mb-1">搜索关键词</div>
          <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent/50"
                 value={query} onChange={e => setQuery(e.target.value)} placeholder="例如 sodium / iris / BSL" />
        </div>
        <div className="w-36">
          <div className="text-[11px] text-slate-500 mb-1">MC 版本</div>
          <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-3 py-2 text-sm font-mono outline-none focus:border-accent/50"
                 value={mcVersion} onChange={e => setMcVersion(e.target.value)} placeholder="1.21.1" />
        </div>
        <div className="w-40">
          <div className="text-[11px] text-slate-500 mb-1">加载器</div>
          <select className="w-full bg-base-900/60 border border-white/10 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent/50"
                  value={loader} onChange={e => setLoader(e.target.value)} disabled={projectType === 'shader'}>
            {LOADERS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <button className="btn-primary text-sm" type="submit" disabled={busy}>{busy ? '搜索中…' : '🔍 搜索'}</button>
      </form>

      <div className="flex flex-wrap gap-2">
        {TYPES.map(t => (
          <button key={t.id}
            className={`btn text-xs ${projectType === t.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => { setProjectType(t.id); setResults(null) }}>
            {t.icon} {t.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-600 self-center">
          安装目标：{DIR_HINT[projectType]} · 下载后按官方 sha512 校验
        </span>
      </div>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>
          {msg.text}
        </div>
      )}

      {progress && installing && (
        <div className="glass-panel px-4 py-2.5 text-xs text-slate-400">
          <span className="text-accent font-mono">[{progress.index}/{progress.total}]</span>{' '}
          {progress.phase === 'done' ? '✓ 已落地' : progress.phase === 'error' ? '✗ 失败' : '下载中'}{' '}
          <span className="font-mono text-slate-300">{progress.name}</span>
          {progress.dependency && <span className="tag bg-mc-gold/15 text-mc-gold ml-2">前置依赖</span>}
          {progress.received != null && progress.total != null && (
            <span className="ml-2 text-slate-600">{Math.round(progress.received / 1024)} KB</span>
          )}
          {progress.error && <span className="text-mc-red ml-2">{progress.error}</span>}
        </div>
      )}

      {lastInstall && (
        <div className="glass-panel p-4 text-xs space-y-1">
          <div className="text-sm font-medium text-slate-300 mb-2">安装明细（真实写盘 + sha512）</div>
          {lastInstall.installed.map((f, i) => (
            <div key={i} className="flex items-center gap-2 font-mono">
              <span className="text-mc-green">✓</span>
              <span className="text-slate-300">{f.name}</span>
              <span className="text-slate-600">{f.size} B</span>
              {f.dependency && <span className="tag bg-mc-gold/15 text-mc-gold">依赖</span>}
            </div>
          ))}
          {lastInstall.missing.map((m, i) => (
            <div key={`m${i}`} className="text-mc-red">✗ 缺失前置 {m.projectId || m.versionId}：{m.reason}</div>
          ))}
          {lastInstall.failures.map((f, i) => (
            <div key={`f${i}`} className="text-mc-red">✗ {f.name}：{f.error}</div>
          ))}
        </div>
      )}

      {results && results.hits.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {results.hits.map(h => (
            <div key={h.projectId} className="glass-panel p-4 flex gap-3">
              {h.iconUrl ? (
                <img src={h.iconUrl} alt="" className="w-12 h-12 rounded-xl bg-base-900 object-cover shrink-0"
                     onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
              ) : (
                <div className="w-12 h-12 rounded-xl bg-base-900 flex items-center justify-center text-lg shrink-0">🧩</div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-200 truncate">{h.title}</span>
                  <span className="tag bg-accent/10 text-accent shrink-0">{h.projectType}</span>
                </div>
                <div className="text-[11px] text-slate-500 line-clamp-2 mt-0.5">{h.description}</div>
                <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-600">
                  <span>⬇ {Number(h.downloads).toLocaleString()}</span>
                  <span>♥ {Number(h.follows).toLocaleString()}</span>
                  <span>by {h.author}</span>
                  <button className="text-accent underline" onClick={() => openDownload(h.sourceUrl)}>项目页</button>
                </div>
                <button className="btn-primary text-xs mt-2" disabled={!!installing}
                        onClick={() => install(h)}>
                  {installing === h.projectId ? '安装中…' : '⬇ 一键下载并安装（含依赖）'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!results && !msg && (
        <div className="glass-panel p-8 text-center text-xs text-slate-600 leading-relaxed">
          输入关键词开始搜索。数据来自 Modrinth 官方 v2 API（facets 精确过滤 MC 版本与加载器），
          安装时会按 version.dependencies 递归补全 required 前置，并对每个文件做官方 sha512 校验。
          <br />无公网连接时不会展示任何模拟结果。
        </div>
      )}
    </div>
  )
}
