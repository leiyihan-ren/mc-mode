import { api } from '@/services'
import React, { useState, useCallback } from 'react'

const KIND_LABEL = {
  'vanilla-server': { text: '原版服务端', color: 'bg-mc-green/15 text-mc-green', icon: '🟩' },
  'forge-installer': { text: 'Forge 安装器', color: 'bg-mc-gold/15 text-mc-gold', icon: '🟨' },
  'neoforge-installer': { text: 'NeoForge 安装器', color: 'bg-mc-orange/15 text-mc-orange', icon: '🟧' },
  'fabric-server': { text: 'Fabric 服务端', color: 'bg-mc-purple/15 text-mc-purple', icon: '🟪' },
  'quilt-server': { text: 'Quilt 服务端', color: 'bg-mc-blue/15 text-mc-blue', icon: '🟦' },
  'unknown': { text: '无法识别', color: 'bg-mc-red/15 text-mc-red', icon: '❓' }
}

export default function ServerPage({ settings, serverRunning, setServerRunning, goto }) {
  const [jarPath, setJarPath] = useState('')
  const [kind, setKind] = useState(null)
  const [workDir, setWorkDir] = useState('/root/.mc-next/server')
  const [memory, setMemory] = useState(settings.serverMemory || 4)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [deployed, setDeployed] = useState(null)

  const detect = useCallback(async (p) => {
    if (!p) return
    setJarPath(p)
    setKind(null)
    setDeployed(null)
    const k = await api.detectServer(p)
    setKind(k)
  }, [])

  const pickJar = useCallback(async () => {
    const p = await api.pickJar()
    if (p) detect(p)
  }, [detect])

  const pickDir = useCallback(async () => {
    const d = await api.pickDir()
    if (d) setWorkDir(d)
  }, [])

  const handleDeploy = useCallback(async () => {
    if (!jarPath) return
    setBusy(true)
    setMessage(null)
    try {
      const r = await api.deployServer({
        jarPath,
        workDir,
        memory: `${memory}G`,
        javaPath: settings.javaPath || 'java'
      })
      if (r.ok) {
        setDeployed(r)
        setMessage({ type: 'ok', text: `部署完成：${r.kind} → ${workDir}（已生成 eula=true 与启动脚本）` })
      } else {
        setMessage({ type: 'error', text: `部署失败: ${r.error}` })
      }
    } catch (e) {
      setMessage({ type: 'error', text: `部署异常: ${e.message}` })
    }
    setBusy(false)
  }, [jarPath, workDir, memory, settings.javaPath])

  const handleStart = useCallback(async () => {
    if (!deployed) return
    setBusy(true)
    try {
      const coreJar = (deployed.coreJar || '').split('/').pop()
      const r = await api.startServer({ workDir, coreJar, memory: `${memory}G`, javaPath: settings.javaPath || 'java' })
      if (r.ok) {
        setServerRunning(true)
        setMessage({ type: 'ok', text: '服务端已启动，前往控制台查看日志' })
        goto('console')
      } else {
        setMessage({ type: 'error', text: `启动失败: ${r.error}` })
      }
    } catch (e) {
      setMessage({ type: 'error', text: `启动异常: ${e.message}` })
    }
    setBusy(false)
  }, [deployed, workDir, memory, settings.javaPath, setServerRunning, goto])

  const handleStop = useCallback(async () => {
    const r = await api.stopServer()
    if (r.ok) { setServerRunning(false); setMessage({ type: 'ok', text: '服务端已停止' }) }
    else setMessage({ type: 'error', text: r.error })
  }, [setServerRunning])

  const kLabel = kind ? (KIND_LABEL[kind] || KIND_LABEL.unknown) : null

  return (
    <div className="h-full flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">服务端部署</h1>
        <p className="text-sm text-slate-500 mt-1">全类型自动识别：原版 / Forge / NeoForge / Fabric / Quilt · Installer 静默安装 · 一键开服</p>
      </header>

      {message && (
        <div className={`glass-panel px-4 py-3 text-sm border ${message.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>
          {message.text}
        </div>
      )}

      <div className="glass-panel p-6 flex flex-col gap-5">
        {/* 1. 选择 Jar */}
        <div className="flex items-center gap-3">
          <button className="btn-ghost text-sm" onClick={pickJar}>📁 选择服务端 Jar</button>
          <div className="flex-1 bg-base-900/60 border border-white/5 rounded-xl px-4 py-2 text-sm font-mono text-slate-400 truncate">
            {jarPath || '未选择文件'}
          </div>
          {kLabel && (
            <span className={`tag ${kLabel.color}`}>{kLabel.icon} {kLabel.text}</span>
          )}
        </div>

        {/* 2. 部署参数 */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-slate-400 mb-2">部署目录</div>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
                value={workDir}
                onChange={e => setWorkDir(e.target.value)}
              />
              <button className="btn-ghost text-xs" onClick={pickDir}>浏览</button>
            </div>
          </div>
          <div>
            <div className="text-sm text-slate-400 mb-2">服务端内存：<span className="text-accent font-mono">{memory}G</span></div>
            <input
              type="range" min="1" max="16" step="1"
              value={memory}
              onChange={e => setMemory(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-slate-600 mt-1"><span>1G</span><span>8G</span><span>16G</span></div>
          </div>
        </div>

        {/* 3. 操作 */}
        <div className="flex items-center gap-3">
          <button
            className="btn-primary text-sm"
            onClick={handleDeploy}
            disabled={!jarPath || busy || kind === 'unknown'}
          >
            {busy && !deployed ? '部署中…' : '⚙️ 开始部署'}
          </button>
          <button
            className="btn-primary text-sm"
            onClick={handleStart}
            disabled={!deployed || busy || serverRunning}
          >
            {serverRunning ? '运行中' : '🚀 启动服务端'}
          </button>
          {serverRunning && (
            <button className="btn-danger text-sm" onClick={handleStop}>■ 停止</button>
          )}
          {deployed && deployed.scripts && (
            <div className="ml-auto text-xs text-slate-500 font-mono">
              启动脚本: {deployed.scripts.sh.split('/').pop()} / {deployed.scripts.bat.split('/').pop()}
            </div>
          )}
        </div>

        {/* 4. 说明 */}
        <div className="text-xs text-slate-600 leading-relaxed border-t border-white/5 pt-4">
          部署流程：自动识别 Jar 类型 → Installer 型静默执行 <span className="font-mono text-slate-500">java -jar xxx.jar --installServer</span> → 写入 eula=true → 生成内存优化的 start.sh / start.bat<br />
          Fabric/Quilt 服务端将引导 Jar 与原版 server.jar 组合部署；NeoForge/Forge 安装器会自动下载 processors 依赖（需要网络）。
        </div>
      </div>
    </div>
  )
}
