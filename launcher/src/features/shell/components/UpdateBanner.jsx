import React, { useEffect, useState } from 'react'
import { api, isMobile } from '@/services'
import { openDownload } from '@/lib/release.js'

/**
 * 0.6.0 模块五：自动更新横幅。
 * 应用每次打开自动请求 GitHub Release 的 latest.yml（桌面）或 /releases/latest（Android）；
 * 发现新版本才出现横幅。桌面支持后台静默下载 + sha512 校验；Android 明确只做检查提示。
 */
export default function UpdateBanner() {
  const [info, setInfo] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  const [progress, setProgress] = useState(null)
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    try {
      const a = api
      if (!a || typeof a.updateCheck !== 'function') return
      const r = await a.updateCheck()
      setInfo(r && r.ok === false ? { ok: false, error: r.error } : r)
    } catch (e) { setInfo({ ok: false, error: e.message }) }
    finally { setChecking(false) }
  }

  useEffect(() => {
    check()
    const a = api
    if (!a || typeof a.onUpdateProgress !== 'function') return
    const off = a.onUpdateProgress(p => setProgress(p))
    return () => { try { off && off() } catch { /* noop */ } }
  }, [])

  if (dismissed || !info || !info.ok || !info.updateAvailable) return null

  const page = info.releasePage || info.page
  const dlUrl = info.mirrorUrl || info.mirrorApkUrl
  const pct = progress && progress.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null

  const download = async () => {
    if (isMobile) { openDownload(page || dlUrl); return }
    try {
      const r = await api.updateDownload({
        url: dlUrl, sha512: info.sha512, version: info.latestVersion
      })
      if (!r || !r.ok) setProgress({ phase: 'error', error: (r && r.error) || '下载启动失败' })
      else setProgress({ phase: 'start', dest: r.dest })
    } catch (e) { setProgress({ phase: 'error', error: e.message }) }
  }

  return (
    <div className="shrink-0 px-4 py-2 bg-accent/10 border-b border-accent/25 flex items-center gap-3 flex-wrap text-xs">
      <span className="text-sm">🎉</span>
      <div className="min-w-0">
        <span className="text-slate-200 font-medium">发现新版本 v{info.latestVersion}</span>
        <span className="text-slate-500 ml-2">当前 v{info.currentVersion}</span>
        {info.releaseDate && <span className="text-slate-600 ml-2">{String(info.releaseDate).slice(0, 10)}</span>}
      </div>

      {isMobile ? (
        <button className="btn-primary text-xs" onClick={download}>前往下载新 APK</button>
      ) : (
        <button className="btn-primary text-xs" onClick={download}
                disabled={!!progress && ['start', 'progress'].includes(progress.phase)}>
          {progress && ['start', 'progress'].includes(progress.phase) ? '后台下载中…' : '⬇ 后台静默下载'}
        </button>
      )}
      <button className="btn-ghost text-xs" onClick={() => openDownload(page)}>更新说明</button>

      {progress && (
        <div className="flex items-center gap-2 min-w-[200px]">
          {progress.phase === 'progress' && pct != null && (
            <>
              <div className="w-28 h-1.5 bg-base-900 rounded-full overflow-hidden">
                <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="font-mono text-slate-500">{pct}%</span>
            </>
          )}
          {progress.phase === 'done' && (
            <span className="text-mc-green" title={progress.path}>✓ sha512 校验通过，安装包已就绪（{progress.path}）</span>
          )}
          {(progress.phase === 'error' || progress.phase === 'verify-failed') && (
            <span className="text-mc-red">✗ {progress.error || (progress.verify && progress.verify.error) || '校验失败'}</span>
          )}
        </div>
      )}

      {isMobile && <span className="text-[10px] text-slate-600 w-full">{info.note}</span>}
      <button className="ml-auto text-slate-500 hover:text-slate-300 px-2" title="本次不再提示" onClick={() => setDismissed(true)}>✕</button>
      {checking && <span className="text-[10px] text-slate-600">检查中…</span>}
    </div>
  )
}
