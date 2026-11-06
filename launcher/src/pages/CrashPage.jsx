import React, { useState } from 'react'

const api = () => window.mcnext

const SEV = { fatal: 'bg-mc-red/15 text-mc-red', error: 'bg-mc-red/10 text-mc-red', warn: 'bg-mc-gold/15 text-mc-gold', info: 'bg-accent/10 text-accent' }

/** 模块四：崩溃原因分析 + latest.log 正则净化 */
export default function CrashPage() {
  const [text, setText] = useState('')
  const [source, setSource] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [clean, setClean] = useState(null)
  const [msg, setMsg] = useState(null)

  const loadLatest = async () => {
    try {
      const r = await api().crashReadLatestLog()
      if (!r.ok) throw new Error(r.error)
      setText(r.text); setSource(r.path); setMsg(null)
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  const run = async () => {
    if (!text.trim()) { setMsg({ ok: false, text: '请先载入或粘贴日志' }); return }
    try {
      setAnalysis(await api().crashAnalyze({ log: text }))
      setClean(await api().crashClean(text))
      setMsg({ ok: true, text: '分析完成' })
    } catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">崩溃诊断</h1>
        <p className="text-sm text-slate-500 mt-1">OOM / 缺库 / Java 版本不匹配 / GL 错误 / Mod 冲突自动归类，并从巨型 latest.log 提取关键堆栈</p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      <section className="glass-panel p-5 space-y-3">
        <div className="flex gap-2 items-center">
          <button className="btn-primary text-sm" onClick={loadLatest}>载入 latest.log</button>
          <button className="btn-ghost text-sm" onClick={run}>分析并净化</button>
          {source && <span className="text-[11px] font-mono text-slate-600 truncate">{source}</span>}
        </div>
        <textarea
          className="w-full h-36 bg-base-900/70 border border-white/10 rounded-xl px-4 py-3 text-[12px] font-mono outline-none focus:border-accent/50 resize-none"
          placeholder="或直接粘贴崩溃日志 / hs_err_pid 内容…"
          value={text} onChange={e => setText(e.target.value)}
        />
      </section>

      {analysis && (
        <section className="glass-panel p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="text-sm font-medium text-slate-300">诊断结果</div>
            <span className={`tag ${SEV[analysis.severity] || SEV.info}`}>{analysis.severity || 'info'}</span>
            {analysis.summary && <span className="text-xs text-slate-400">{analysis.summary}</span>}
          </div>
          {(analysis.findings || []).length === 0 ? (
            <div className="text-xs text-slate-600">未匹配到已知崩溃规则，请查看净化后的堆栈人工判断。</div>
          ) : (
            <div className="space-y-3">
              {analysis.findings.map((f, i) => (
                <div key={i} className="bg-base-900/60 border border-white/5 rounded-xl p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`tag ${SEV[f.severity] || SEV.info}`}>{f.severity}</span>
                    <span className="text-sm text-slate-200 font-medium">{f.title}</span>
                    <span className="text-[10px] font-mono text-slate-600 ml-auto">{f.code}</span>
                  </div>
                  {f.advice && <div className="text-xs text-mc-green/90 mb-2">→ {f.advice}</div>}
                  <div className="space-y-0.5">{(f.matches || []).map((m, j) => (
                    <div key={j} className="text-[11px] font-mono text-slate-500 break-all">{m}</div>
                  ))}</div>
                </div>
              ))}
            </div>
          )}
          {analysis.javaRequirement && (
            <div className="text-xs text-slate-400 mt-3">所需 Java 版本：{JSON.stringify(analysis.javaRequirement)}</div>
          )}
          {analysis.modSuspects?.length > 0 && (
            <div className="text-xs text-mc-gold mt-2">可疑 Mod：{analysis.modSuspects.join(', ')}</div>
          )}
        </section>
      )}

      {clean && (
        <section className="glass-panel p-5">
          <div className="text-sm font-medium text-slate-300 mb-2">日志净化报告（堆栈提取 + 去重 + 敏感信息脱敏）</div>
          <pre className="max-h-80 overflow-auto text-[11px] font-mono text-slate-400 bg-black/30 rounded-xl p-3 whitespace-pre-wrap break-all">
{clean.report || JSON.stringify(clean, null, 2)}
          </pre>
        </section>
      )}
    </div>
  )
}
