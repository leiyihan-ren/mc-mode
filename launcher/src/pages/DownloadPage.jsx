import React, { useEffect, useState, useCallback } from 'react'

export default function DownloadPage({ goto }) {
  const [manifest, setManifest] = useState(null)
  const [releases, setReleases] = useState([])
  const [local, setLocal] = useState([])
  const [tasks, setTasks] = useState({}) // id -> {received,total,status}
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const refreshLocal = useCallback(() => {
    window.mcnext.listClients().then(list => setLocal(list.map(f => f.replace(/\.jar$/, ''))))
  }, [])

  useEffect(() => {
    window.mcnext.fetchManifest().then(raw => {
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
  }, [refreshLocal])

  useEffect(() => {
    const api = window.mcnext
    api.onDownloadProgress(p => setTasks(t => ({ ...t, [p.id]: { ...t[p.id], ...p, status: 'downloading' } })))
    api.onDownloadDone(p => setTasks(t => ({ ...t, [p.id]: { ...t[p.id], status: 'done' } })))
    api.onDownloadError(p => setTasks(t => ({ ...t, [p.id]: { ...t[p.id], status: 'error', error: p.error } })))
  }, [])

  const handleDownload = useCallback(async (versionId) => {
    setTasks(t => ({ ...t, [versionId]: { status: 'starting', received: 0, total: 0 } }))
    try {
      // 1. 下载版本 JSON（含 client jar 官方地址）
      const vj = await window.mcnext.getVersionJson(versionId)
      const client = vj.downloads && vj.downloads.client
      if (!client) throw new Error('该版本无客户端下载信息')
      const dest = `/workspace/MC正式版客户端/${versionId}.jar`
      const r = await window.mcnext.startDownload({
        id: versionId,
        url: client.url,
        dest,
        sha1: client.sha1,
        size: client.size
      })
      if (r.ok) refreshLocal()
      else setTasks(t => ({ ...t, [versionId]: { status: 'error', error: r.error } }))
    } catch (e) {
      setTasks(t => ({ ...t, [versionId]: { status: 'error', error: e.message } }))
    }
  }, [refreshLocal])

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
                              className={`h-full rounded-full transition-all ${t.status === 'error' ? 'bg-mc-red' : t.status === 'done' ? 'bg-mc-green' : 'bg-accent'}`}
                              style={{ width: t.total ? `${Math.min(100, (t.received / t.total) * 100)}%` : t.status === 'done' ? '100%' : '30%' }}
                            />
                          </div>
                          <span className={`text-xs ${t.status === 'error' ? 'text-mc-red' : 'text-slate-400'}`}>
                            {t.status === 'error' ? (t.error || '失败').slice(0, 30) : t.status === 'done' ? '完成' : t.total ? `${(t.received / 1048576).toFixed(1)}/${(t.total / 1048576).toFixed(1)}MB` : '准备中'}
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
                        {has ? '重新下载' : t && t.status === 'downloading' ? '下载中…' : '⬇ 下载'}
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
