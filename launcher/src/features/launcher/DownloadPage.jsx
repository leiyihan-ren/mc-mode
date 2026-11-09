import { api, createSubscriptionSet } from '@/services'
import React, { useEffect, useState, useCallback } from 'react'

// 0.9.0 模块一B：节点测速样本 URL。mirrorFirstCandidates 会把它展开为
// [BMCLAPI 镜像, Mojang 官方] 两个真实节点，用于探测两源延迟，不含任何假数据。
const BENCH_SAMPLE_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'

export default function DownloadPage({ goto }) {
  const [manifest, setManifest] = useState(null)
  const [releases, setReleases] = useState([])
  const [local, setLocal] = useState([])
  const [tasks, setTasks] = useState({}) // id -> {received,total,status,retry,mode,chunks}
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [sources, setSources] = useState(null)
  // —— 0.9.0 模块一B：智能下载 / 节点测速 UI 状态 ——
  const [smartMode, setSmartMode] = useState(true)
  const [bench, setBench] = useState(null)
  const [benchmarking, setBenchmarking] = useState(false)
  const [lastInfo, setLastInfo] = useState(null) // 最近一次智能下载的真实结果摘要

  const refreshLocal = useCallback(() => {
    api.listClients().then(list => setLocal(list.map(f => f.replace(/\.jar$/, ''))))
  }, [])

  useEffect(() => {
    api.fetchManifest().then(raw => {
      setManifest(raw)
      const rel = (raw.versions || [])
        .filter(v => v.type === 'release')
        .map(v => v.id)
        .sort((a, b) => {
          const na = Number(a.split('.')[0]) >= 26 ? 100 : Number(a.split('.')[0])
          const nb = Number(b.split('.')[0]) >= 26 ? 100 : Number(b.split('.')[0])
          if (na !== nb) return nb - na
          return b.localeCompare(a)
        })
      setReleases(rel)
      setLoading(false)
    }).catch(() => setLoading(false))
    refreshLocal()
    api.downloadSources?.().then(setSources).catch(() => {})
  }, [refreshLocal])

  useEffect(() => {
    // 0.9.0 模块二C：4 个下载事件订阅统一收集，卸载时全部注销（页面反复进出不再累积回调）
    const subs = createSubscriptionSet()
    subs.add(api.onDownloadProgress(p => setTasks(t => ({ ...t, [p.id]: { ...t[p.id], ...p, status: 'downloading', retry: null } }))))
    // 0.9.0：done 事件携带 mode/chunks，用于区分「并发分块」与「单连接多源」结果。
    subs.add(api.onDownloadDone(p => setTasks(t => ({ ...t, [p.id]: { ...t[p.id], status: 'done', mode: p.mode, chunks: p.chunks, retry: null } }))))
    subs.add(api.onDownloadError(p => setTasks(t => ({ ...t, [p.id]: { ...t[p.id], status: 'error', error: p.error } }))))
    // 0.4.0：真实重试 / 换源事件（BMCLAPI 首选 → Mojang 官方备用，指数退避）
    // 0.9.0：兼容 download:smart 并发回退事件（无 urlIndex，改显真实 error，避免 NaN/NaN）。
    subs.add(api.onDownloadRetry?.(p => setTasks(t => ({
      ...t,
      [p.id]: {
        ...t[p.id],
        status: 'retrying',
        retry: p.switched
          ? (p.urlIndex != null ? `已切换备用源 ${p.urlIndex + 1}/${p.urlCount}` : (p.error || '并发下载回退到单连接多源降级'))
          : `重试 ${p.attempt}/${p.maxAttempts} · ${p.delayMs}ms 退避`
      }
    }))))
    return () => subs.disposeAll()
  }, [])

  // 0.9.0 模块一B：真实节点测速（后端并发探测，无公网时如实返回不可用，不伪造延迟）
  const runBenchmark = useCallback(async () => {
    setBenchmarking(true)
    setBench(null)
    try {
      const r = await api.benchmarkDownload({ url: BENCH_SAMPLE_URL })
      setBench(r)
    } catch (e) {
      setBench({ ok: false, results: [], error: e.message, note: '测速接口不可用（可能非桌面 / 安卓运行环境）' })
    } finally {
      setBenchmarking(false)
    }
  }, [])

  const handleDownload = useCallback(async (versionId) => {
    setLastInfo(null)
    setTasks(t => ({ ...t, [versionId]: { status: 'starting', received: 0, total: 0 } }))
    try {
      // 1. 下载版本 JSON（含 client jar 官方地址）
      const vj = await api.getVersionJson(versionId)
      const client = vj.downloads && vj.downloads.client
      if (!client) throw new Error('该版本无客户端下载信息')
      const dest = `/workspace/MC正式版客户端/${versionId}.jar`
      const payload = { id: versionId, url: client.url, dest, sha1: client.sha1, size: client.size }
      // 2. 智能下载：测速选最快节点 → 并发分块 + 断点续传 → 失败回退单连接多源降级链。
      //    关闭开关时走回 0.4.0 既有 startDownload，行为完全不变。
      const r = smartMode ? await api.smartDownload(payload) : await api.startDownload(payload)
      if (r.ok) {
        refreshLocal()
        if (smartMode) setLastInfo({ versionId, ...r })
      } else setTasks(t => ({ ...t, [versionId]: { status: 'error', error: r.error } }))
    } catch (e) {
      setTasks(t => ({ ...t, [versionId]: { status: 'error', error: e.message } }))
    }
  }, [refreshLocal, smartMode])

  const filtered = releases.filter(v => !filter || v.includes(filter))
  const localSet = new Set(local)

  return (
    <div className="h-full flex flex-col gap-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">下载中心</h1>
          <p className="text-sm text-slate-500 mt-1">
            官方版本清单（launchermeta）· 本地已收录 <span className="text-accent font-mono">{local.length}</span> / {releases.length} 个正式版
          </p>
        </div>
        <input
          className="bg-base-800 border border-white/10 rounded-xl px-4 py-2 text-sm w-64 outline-none focus:border-accent/50 transition-colors"
          placeholder="搜索版本号，如 1.21"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </header>

      {sources && (
        <div className="glass-panel px-4 py-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="tag bg-mc-green/15 text-mc-green">首选 · {sources.primary.name}</span>
          <span className="text-slate-600">→</span>
          <span className="tag bg-white/5 text-slate-400">备用 · Mojang 官方（{sources.fallback.length} 个源）</span>
          <span className="text-slate-600 truncate">{sources.retry}</span>
        </div>
      )}
      {!sources && <div className="text-xs text-slate-600 -mt-2">下载策略：BMCLAPI 首选 / Mojang 官方备用 · 失败指数退避重试</div>}

      {/* 0.9.0 模块一B：智能下载控制面板 —— 开关 / 节点测速 / 真实结果 / 最近下载摘要 */}
      <div className="glass-panel px-4 py-3 flex flex-col gap-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tag bg-accent/15 text-accent">0.9.0 · 智能下载</span>
          <button
            className={`btn text-xs ${smartMode ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSmartMode(v => !v)}
            title="开启后：自动测速选最快节点，多线程分块并发下载，支持断点续传，失败自动回退单连接多源降级"
          >
            {smartMode ? '✓ 智能下载已启用' : '智能下载已关闭'}
          </button>
          <button className="btn btn-ghost text-xs" onClick={runBenchmark} disabled={benchmarking}>
            {benchmarking ? '测速中…' : '⚡ 节点测速'}
          </button>
          {bench && (
            <span className={bench.ok ? 'text-mc-green' : 'text-mc-gold'}>
              {bench.ok
                ? `最快：${bench.winner?.name} · ${bench.winner?.latencyMs}ms${bench.cached ? '（缓存）' : ''}`
                : (bench.error || '所有节点不可用')}
            </span>
          )}
          {!smartMode && <span className="text-slate-600">当前为经典单连接下载（0.4.0 多源降级链）</span>}
        </div>
        {bench && bench.results && bench.results.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {bench.results.map((r, i) => (
              <span key={i} className={`tag ${r.ok ? 'bg-mc-green/15 text-mc-green' : 'bg-white/5 text-slate-500'}`}>
                {i === 0 && r.ok ? '★ ' : ''}{r.name} · {r.ok ? `${r.latencyMs}ms` : `不可用${r.error ? ` (${String(r.error).slice(0, 24)})` : ''}`}
              </span>
            ))}
          </div>
        )}
        {bench && !bench.ok && bench.note && <div className="text-mc-gold/80">{bench.note}</div>}
        {lastInfo && (
          <div className="text-slate-400 border-t border-white/5 pt-2">
            最近下载 <span className="font-mono text-slate-200">{lastInfo.versionId}</span> · 模式{' '}
            <span className="tag bg-mc-blue/15 text-mc-blue">
              {lastInfo.mode === 'parallel' ? `并发 ${lastInfo.chunks} 段` : '单连接多源'}
            </span>
            {lastInfo.benchmarked && <span className="ml-2 text-mc-green">已按最快节点</span>}
            {lastInfo.resumed > 0 && <span className="ml-2">断点续传 {lastInfo.resumed} 段</span>}
            {lastInfo.usedUrl && <div className="truncate text-slate-600 mt-1">节点：{lastInfo.usedUrl}</div>}
          </div>
        )}
      </div>

      <div className="flex-1 glass-panel overflow-hidden flex flex-col">
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-base-800/95 backdrop-blur-xs text-slate-500 text-xs">
              <tr>
                <th className="text-left px-5 py-3 font-medium">版本</th>
                <th className="text-left px-5 py-3 font-medium">类型</th>
                <th className="text-left px-5 py-3 font-medium">状态</th>
                <th className="text-right px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={4} className="px-5 py-8 text-center text-slate-600">正在获取版本清单…</td></tr>
              )}
              {filtered.map(v => {
                const has = localSet.has(v)
                const t = tasks[v]
                return (
                  <tr key={v} className="border-t border-white/5 hover:bg-white/[0.02] transition-colors">
                    <td className="px-5 py-2.5 font-mono text-slate-300">{v}</td>
                    <td className="px-5 py-2.5"><span className="tag bg-mc-blue/15 text-mc-blue">release</span></td>
                    <td className="px-5 py-2.5">
                      {has ? (
                        <span className="tag bg-mc-green/15 text-mc-green">已收录</span>
                      ) : t ? (
                        <div className="flex items-center gap-2">
                          <div className="w-32 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${t.status === 'error' ? 'bg-mc-red' : t.status === 'done' ? 'bg-mc-green' : t.status === 'retrying' ? 'bg-mc-gold' : 'bg-accent'}`}
                              style={{ width: t.total ? `${Math.min(100, (t.received / t.total) * 100)}%` : t.status === 'done' ? '100%' : '30%' }}
                            />
                          </div>
                          <span className={`text-xs ${t.status === 'error' ? 'text-mc-red' : t.status === 'retrying' ? 'text-mc-gold' : 'text-slate-400'}`}>
                            {t.status === 'error' ? (t.error || '失败').slice(0, 30)
                              : t.status === 'retrying' ? (t.retry || '重试中')
                                : t.status === 'done' ? (t.mode === 'parallel' ? `完成 · 并发 ${t.chunks} 段` : '完成')
                                  : t.total ? `${(t.received / 1048576).toFixed(1)}/${(t.total / 1048576).toFixed(1)}MB` : '准备中'}
                          </span>
                        </div>
                      ) : (
                        <span className="tag bg-white/5 text-slate-500">未下载</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <button
                        className={`btn text-xs ${has ? 'btn-ghost' : 'btn-primary'}`}
                        disabled={t && (t.status === 'starting' || t.status === 'downloading')}
                        onClick={() => handleDownload(v)}
                      >
                        {has ? '重新下载' : t && t.status === 'downloading' ? '下载中…' : smartMode ? '⬇ 智能下载' : '⬇ 下载'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
