import React, { useState } from 'react'

const api = () => window.mcnext

/** 模块三：本地原版/加载器 Jar 智能解析、Natives 提取与 overlay 合并 */
export default function LocalJarPage() {
  const [gameJar, setGameJar] = useState('')
  const [loaders, setLoaders] = useState([])
  const [libs, setLibs] = useState([])
  const [inspect, setInspect] = useState(null)
  const [plan, setPlan] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const pickGame = async () => {
    const p = await api().pickJar()
    if (!p) return
    setGameJar(p); setPlan(null)
    try { setInspect(await api().localJarInspect(p)); setMsg(null) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }
  const addLoader = async () => { const p = await api().pickJar(); if (p) setLoaders(l => [...l, p]) }
  const addLib = async () => { const p = await api().pickJar(); if (p) setLibs(l => [...l, p]) }

  const build = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await api().localJarPlan({ gameJar, loaderJars: loaders, libraries: libs, id: 'manual' })
      setPlan(r)
      setMsg({ ok: true, text: r.merged ? `已 overlay 合并加载器到游戏 Jar（输出 ${r.gameJar}）` : '已生成 classpath 启动方案' })
    } catch (e) { setMsg({ ok: false, text: `解析失败：${e.message}` }) }
    finally { setBusy(false) }
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">本地 Jar 解析</h1>
        <p className="text-sm text-slate-500 mt-1">手动选择原版客户端与加载器 Jar，自动识别类型、合并 Natives、剔除签名并产出启动方案</p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      <section className="glass-panel p-5 space-y-4">
        <div>
          <div className="text-xs text-slate-400 mb-2">① 原版客户端 Jar（必填）</div>
          <button className="btn-primary text-sm" onClick={pickGame}>选择游戏 Jar</button>
          {gameJar && <div className="text-xs font-mono text-slate-500 mt-2 break-all">{gameJar}</div>}
          {inspect && (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              <span className="tag bg-accent/15 text-accent">识别：{inspect.kind}</span>
              <span className="tag bg-white/5 text-slate-400">版本：{inspect.gameVersion || '未知'}</span>
              <span className="tag bg-white/5 text-slate-400">条目：{inspect.entryCount ?? '-'}</span>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-2">② 加载器 Jar（可多选：Forge installer / Fabric / Quilt / NeoForge）</div>
          <button className="btn-ghost text-sm" onClick={addLoader}>＋ 添加加载器 Jar</button>
          <div className="mt-2 space-y-1">{loaders.map((p, i) => (
            <div key={i} className="text-[11px] font-mono text-slate-500 flex gap-2">
              <span className="text-slate-600">{i + 1}.</span><span className="break-all">{p}</span>
              <button className="text-mc-red" onClick={() => setLoaders(l => l.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}</div>
        </div>

        <div>
          <div className="text-xs text-slate-400 mb-2">③ 依赖库 / Natives Jar（可多选，自动提取 .so/.dll 并剔除 META-INF 签名）</div>
          <button className="btn-ghost text-sm" onClick={addLib}>＋ 添加依赖库</button>
          <div className="mt-2 space-y-1">{libs.map((p, i) => (
            <div key={i} className="text-[11px] font-mono text-slate-500 flex gap-2">
              <span className="text-slate-600">{i + 1}.</span><span className="break-all">{p}</span>
              <button className="text-mc-red" onClick={() => setLibs(l => l.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}</div>
        </div>

        <button className="btn-primary text-sm" onClick={build} disabled={busy || !gameJar}>
          {busy ? '解析中…' : '智能解析并生成启动方案'}
        </button>
      </section>

      {plan && (
        <section className="glass-panel p-5 space-y-3">
          <div className="text-sm font-medium text-slate-300">启动方案</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="bg-base-900/60 rounded-xl p-3"><div className="text-slate-500">游戏版本</div><div className="font-mono text-slate-200">{plan.gameVersion}</div></div>
            <div className="bg-base-900/60 rounded-xl p-3"><div className="text-slate-500">已合并</div><div className="font-mono text-slate-200">{plan.merged ? '是' : '否'}</div></div>
            <div className="bg-base-900/60 rounded-xl p-3"><div className="text-slate-500">Natives</div><div className="font-mono text-slate-200">{plan.natives?.length || 0}</div></div>
            <div className="bg-base-900/60 rounded-xl p-3"><div className="text-slate-500">Classpath</div><div className="font-mono text-slate-200">{plan.classpath?.length || 0} 项</div></div>
          </div>
          {plan.warnings?.length > 0 && (
            <div className="text-xs text-mc-gold space-y-1">{plan.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
          )}
          <pre className="text-[11px] font-mono text-slate-400 bg-black/30 rounded-xl p-3 whitespace-pre-wrap break-all">
{plan.jvmArgs?.join(' ')}
          </pre>
          <div className="text-[11px] text-slate-600 font-mono break-all">合并产物：{plan.gameJar}</div>
        </section>
      )}
    </div>
  )
}
