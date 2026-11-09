import { api, appendBounded, createSubscriptionSet, BUFFER_LIMITS } from '@/services'
import React, { useEffect, useState, useCallback } from 'react'

/** 模块一：Java 运行环境智能管家页面 */
export default function JavaManagerPage({ settings, setSettings }) {
  const [scan, setScan] = useState(null)
  const [mcVersion, setMcVersion] = useState('1.20.1')
  const [required, setRequired] = useState(null)
  const [match, setMatch] = useState(null)
  const [installing, setInstalling] = useState(null)
  const [installLog, setInstallLog] = useState([])
  const [msg, setMsg] = useState(null)

  const refreshScan = useCallback(async () => {
    try {
      const r = await api.javaScan()
      setScan(r)
    } catch (e) { setMsg({ type: 'error', text: `扫描失败: ${e.message}` }) }
  }, [])

  useEffect(() => { refreshScan() }, [refreshScan])

  const analyze = useCallback(async () => {
    setMsg(null)
    try {
      const req = await api.javaRequired(mcVersion)
      setRequired(req)
      const m = await api.javaSelect(mcVersion)
      setMatch(m)
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }, [mcVersion])

  useEffect(() => { if (mcVersion) analyze() }, [analyze])

  const onProgress = useCallback((p) => {
    const line = p.stage + (p.sha256 ? ` ✓${p.sha256.slice(0, 8)}` : p.url ? ` ${p.url}` : '')
    // 0.9.0 模块二C：统一有界缓冲（此前 [...l.slice(-40), line] 实际会稳定在 41 项）
    setInstallLog(l => appendBounded(l, line, BUFFER_LIMITS.INSTALL_LOG))
  }, [])

  useEffect(() => {
    if (!api || !api.onJavaProgress) return
    // 0.9.0 模块二C：订阅随卸载注销，反复进出页面不累积监听器
    const subs = createSubscriptionSet()
    subs.add(api.onJavaProgress(onProgress))
    return () => subs.disposeAll()
  }, [onProgress])

  const doInstall = async (major) => {
    setInstalling(major)
    setInstallLog([])
    setMsg(null)
    try {
      const r = await api.javaInstall(major)
      if (r.ok) {
        setMsg({ type: 'ok', text: `✓ 已安装 Java ${major} 到 ${r.java.path}` })
        await refreshScan()
        await analyze()
      } else {
        setMsg({ type: 'error', text: r.error })
      }
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
    setInstalling(null)
  }

  const useJava = (path) => {
    setSettings({ ...settings, javaPath: path })
    setMsg({ type: 'ok', text: `已设置为默认 Java：${path}` })
  }

  return (
    <div className="h-full flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">Java 运行环境智能管家</h1>
        <p className="text-sm text-slate-500 mt-1">自动扫描本机 JDK 8/17/21，按 MC 版本匹配正确 Java；缺失时从 Adoptium / 清华镜像下载并校验</p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 flex-1">
        {/* 左：版本匹配 */}
        <div className="glass-panel p-6 flex flex-col gap-4 overflow-y-auto">
          <div>
            <div className="text-sm font-medium text-slate-300 mb-2">选择 MC 版本，自动匹配所需 Java</div>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
                value={mcVersion} onChange={e => setMcVersion(e.target.value)} placeholder="如 1.12.2 / 1.20.1 / 1.21.4"
              />
              <button className="btn-primary text-sm" onClick={analyze}>分析</button>
            </div>
          </div>

          {required && (
            <div className="bg-base-900/50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">所需 Java</span><span className="text-accent font-medium">{required.label}（Java {required.java}）</span></div>
              <div className="flex justify-between"><span className="text-slate-500">依据</span><span className="text-slate-400 text-xs">{required.reason}</span></div>
            </div>
          )}

          {match && (
            <div className="bg-base-900/50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">匹配结果</span>
                <span className={match.ok ? 'text-mc-green' : 'text-mc-red'}>
                  {match.ok ? (match.match === 'exact' ? '✓ 精确匹配' : match.match === 'newer' ? '⚠ 更高版本兼容' : '✓ 已下载') : '✗ 本机缺失'}
                </span>
              </div>
              {match.java && (
                <div className="flex justify-between"><span className="text-slate-500">Java 路径</span><span className="text-slate-300 font-mono text-xs break-all">{match.java.path}</span></div>
              )}
              {match.warning && <div className="text-xs text-mc-gold leading-relaxed">{match.warning}</div>}
              {!match.ok && required && (
                <button className="btn-primary text-sm mt-2" disabled={installing === required.java} onClick={() => doInstall(required.java)}>
                  {installing === required.java ? '下载安装中…' : `一键下载并安装 Java ${required.java}`}
                </button>
              )}
              {match.ok && match.java && (
                <button className="btn-ghost text-sm mt-2" onClick={() => useJava(match.java.path)}>设为默认 Java</button>
              )}
            </div>
          )}

          {installing && (
            <div className="bg-base-900/50 rounded-xl p-3 text-xs font-mono text-slate-400 max-h-40 overflow-y-auto">
              {installLog.length ? installLog.map((l, i) => <div key={i}>{l}</div>) : '准备下载…'}
            </div>
          )}
        </div>

        {/* 右：本机扫描 */}
        <div className="glass-panel p-6 flex flex-col gap-3 overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-300">本机已安装 Java</div>
            <button className="btn-ghost text-xs" onClick={refreshScan}>重新扫描</button>
          </div>
          {!scan && <div className="text-sm text-slate-500">扫描中…</div>}
          {scan && scan.list.length === 0 && <div className="text-sm text-slate-500">未扫描到 Java 安装。请安装 JDK 或使用上方「一键下载」。</div>}
          <div className="space-y-2">
            {scan && scan.list.map((j, i) => (
              <div key={i} className="bg-base-900/50 rounded-xl px-4 py-3 flex items-center gap-3">
                <span className={`w-2.5 h-2.5 rounded-full ${j.recognized ? 'bg-mc-green' : 'bg-slate-600'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-200 font-mono">Java {j.major ?? '未知'}{j.version ? ` · ${j.version}` : ''}</div>
                  <div className="text-xs text-slate-500 truncate">{j.path}</div>
                  {j.vendor && <div className="text-[10px] text-slate-600">{j.vendor} · {j.source}</div>}
                </div>
                {j.recognized && (
                  <button className="btn-ghost text-xs shrink-0" onClick={() => useJava(j.path)}>使用</button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
