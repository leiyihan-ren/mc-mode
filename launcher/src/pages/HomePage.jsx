import React, { useEffect, useState, useCallback, useRef } from 'react'
import { isMobile, remoteApi, getPC } from '../lib/remote.js'

/** 版本号排序：新→旧 */
function verSort(a, b) {
  const pa = a.replace(/-.*/, '').split('.').map(Number)
  const pb = b.replace(/-.*/, '').split('.').map(Number)
  const numA = Number(pa[0]) >= 26 ? 100 : Number(pa[0])
  const numB = Number(pb[0]) >= 26 ? 100 : Number(pb[0])
  if (numA !== numB) return numB - numA
  for (let i = 1; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0
    if (x !== y) return y - x
  }
  return b.localeCompare(a)
}

export default function HomePage({ settings, setSettings, gameRunning, setGameRunning, goto, playLaunchFx }) {
  const [versions, setVersions] = useState([])
  const [selected, setSelected] = useState(null)
  const [loaders, setLoaders] = useState([])
  const [selectedLoader, setSelectedLoader] = useState('')
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [pcStatus, setPcStatus] = useState(null)
  const [remoteMode, setRemoteMode] = useState(false)
  const [message, setMessage] = useState(null)
  const [recommendedJava, setRecommendedJava] = useState(null)

  const javaPath = settings.javaPath || 'java'
  const minMemory = settings.minMemory || '1G'
  const maxMemory = settings.maxMemory || '4G'
  const playerName = settings.playerName || 'Player'

  useEffect(() => {
    if (!isMobile) {
      window.mcnext.listClients().then(list => {
        const sorted = list.map(f => f.replace(/\.jar$/, '')).sort(verSort)
        setVersions(sorted)
        if (sorted.length && !selected) setSelected(sorted[0])
        setLoading(false)
      })
      return
    }
    // 移动端：从局域网 PC 拉取版本列表
    setRemoteMode(true)
    const load = async () => {
      try {
        const r = await remoteApi.clients()
        if (r.ok) {
          setVersions(r.clients)
          if (r.clients.length) setSelected(prev => prev || r.clients[0])
          const st = await remoteApi.status()
          setPcStatus(st)
        }
      } catch (e) {
        setMessage({ type: 'error', text: e.message })
      }
      setLoading(false)
    }
    load()
    const iv = setInterval(load, 10000)
    return () => clearInterval(iv)
  }, [])

  useEffect(() => {
    if (!selected) return
    // 模块一：未显式指定 Java 时，询问 Java 管家推荐路径（仅本地扫描，不联网）
    if (!isMobile && !settings.javaPath) {
      window.mcnext.javaSelect(selected).then(m => {
        if (m.ok) setRecommendedJava(m.java.path)
        else setRecommendedJava(null)
      }).catch(() => setRecommendedJava(null))
    } else {
      setRecommendedJava(null)
    }
    if (isMobile) {
      // 移动端加载器列表来自云端仓库认知（Fabric/Quilt loader + Forge/NeoForge installer）
      const gen = [
        'fabric-loader-0.20.1.jar', 'quilt-loader-0.24.0.jar',
        `forge-${selected}-installer.jar`, `neoforge-${selected}-installer.jar`
      ]
      setLoaders(gen.filter(f => !f.includes('undefined')))
      setSelectedLoader('')
      return
    }
    window.mcnext.listLoaderFiles(selected).then(files => {
      setLoaders(files)
      setSelectedLoader('')
    })
  }, [selected])

  const handleLaunch = useCallback(async () => {
    if (!selected) return
    setLaunching(true)
    setMessage(null)
    // 0.5.0 模块一：点击即触发「启动器缩小淡出 → 进入游戏」过渡动画（纯视觉，不阻塞 JVM）
    const fxDone = playLaunchFx ? playLaunchFx(selected) : Promise.resolve()
    const jvmProfileId = settings.jvmProfileId || null
    const extraJvmArgsText = settings.extraJvmArgsText || ''
    if (remoteMode) {
      // 局域网串流启动：让 PC 端 MC-Next 去跑游戏，手机当遥控器
      try {
        const r = await remoteApi.launch({
          versionId: selected,
          loader: selectedLoader || undefined,
          playerName: playerName,
          minMemory, maxMemory
        })
        if (r.ok) {
          setGameRunning(true)
          setMessage({ type: 'ok', text: `📡 已向电脑发送启动指令：${selected}${selectedLoader ? ` + ${selectedLoader}` : ''}，请回到电脑前查看` })
          await fxDone
          goto('console')
        } else {
          setMessage({ type: 'error', text: `电脑端拒绝启动: ${r.error}` })
        }
      } catch (e) {
        setMessage({ type: 'error', text: e.message })
      }
      setLaunching(false)
      return
    }
    try {
      const vj = await window.mcnext.getVersionJson(selected)
      // 未显式指定 Java 时，使用 Java 管家推荐路径（本地匹配，不强制联网下载）
      const resolvedJava = (!settings.javaPath && recommendedJava) ? recommendedJava : javaPath
      const loaderJar = selectedLoader
        ? `/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d56-08153a6a8000/模组加载器/${selected}/${selectedLoader}`
        : null
      const r = await window.mcnext.launchGame({
        versionId: selected,
        versionJson: vj,
        javaPath: resolvedJava,
        minMemory,
        maxMemory,
        playerName,
        jvmProfileId,
        extraJvmArgsText,
        extraJars: loaderJar ? [loaderJar] : []
      })
      if (r.ok) {
        setGameRunning(true)
        setMessage({ type: 'ok', text: `已启动 ${selected}${selectedLoader ? ` + ${selectedLoader}` : ''}${r.missingCount ? `（自动补全 ${r.missingCount} 个依赖）` : ''}` })
        await fxDone
        goto('console')
      } else {
        setMessage({ type: 'error', text: `启动失败: ${r.error}` })
      }
    } catch (e) {
      setMessage({ type: 'error', text: `启动异常: ${e.message}` })
    }
    setLaunching(false)
  }, [selected, selectedLoader, javaPath, minMemory, maxMemory, playerName, remoteMode, settings, recommendedJava, playLaunchFx, goto])

  return (
    <div className="h-full flex flex-col gap-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">游戏启动</h1>
          <p className="text-sm text-slate-500 mt-1">选择本地仓库中的正式版客户端，一键启动（自动补全依赖）</p>
        </div>
        <div className="flex items-center gap-3">
          {remoteMode ? (
            <div className={`glass-panel px-4 py-2 text-sm flex items-center gap-2 ${pcStatus ? 'text-mc-green' : 'text-slate-400'}`}>
              <span className={`w-2 h-2 rounded-full ${pcStatus ? 'bg-mc-green animate-pulse' : 'bg-slate-600'}`} />
              {pcStatus ? `已连接 ${getPC()}` : getPC() ? '连接中…' : '未配置电脑 IP'}
            </div>
          ) : (
            <>
              <div className="glass-panel px-4 py-2 text-sm">
                <span className="text-slate-500">Java</span>
                <span className="ml-2 text-slate-300 font-mono">{settings.javaPath || (recommendedJava ? `${recommendedJava}（管家推荐）` : 'java')}</span>
              </div>
              <div className="glass-panel px-4 py-2 text-sm">
                <span className="text-slate-500">内存</span>
                <span className="ml-2 text-slate-300 font-mono">{minMemory} - {maxMemory}</span>
              </div>
            </>
          )}
        </div>
      </header>

      {message && (
        <div className={`glass-panel px-4 py-3 text-sm border ${message.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>
          {message.text}
        </div>
      )}

      <div className="flex-1 flex gap-5 min-h-0">
        {/* 版本列表 */}
        <div className="w-64 shrink-0 glass-panel flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 text-sm font-medium text-slate-400">
            正式版客户端（{versions.length}）
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {loading && <div className="text-slate-500 text-sm p-3">加载中…</div>}
            {!loading && versions.length === 0 && (
              <div className="text-slate-500 text-sm p-3">本地仓库为空，请前往下载中心</div>
            )}
            {versions.map(v => (
              <div
                key={v}
                onClick={() => setSelected(v)}
                className={`px-3 py-2 rounded-lg cursor-pointer text-sm font-mono transition-colors ${
                  selected === v ? 'bg-accent/15 text-accent border border-accent/25' : 'text-slate-400 hover:bg-white/5'
                }`}
              >
                {v}
              </div>
            ))}
          </div>
        </div>

        {/* 启动面板 */}
        <div className="flex-1 glass-panel p-6 flex flex-col gap-5 overflow-y-auto">
          {selected ? (
            <>
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-base-600 to-base-700 border border-white/10 flex items-center justify-center text-2xl">
                  ⛏️
                </div>
                <div>
                  <div className="text-xl font-bold text-slate-100 font-mono">{selected}</div>
                  <div className="text-sm text-slate-500">Minecraft Java 版 · 正式版</div>
                </div>
                <span className="tag bg-mc-green/15 text-mc-green ml-auto">已收录</span>
              </div>

              <div>
                <div className="text-sm font-medium text-slate-400 mb-2">模组加载器（可选，本地仓库）</div>
                {loaders.length === 0 ? (
                  <div className="text-sm text-slate-600">该版本暂无本地加载器文件</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={`btn text-xs ${!selectedLoader ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setSelectedLoader('')}
                    >
                      原版
                    </button>
                    {loaders.map(f => (
                      <button
                        key={f}
                        className={`btn text-xs font-mono ${selectedLoader === f ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setSelectedLoader(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-auto flex items-center gap-4">
                <button
                  className="btn-primary text-base px-8 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleLaunch}
                  disabled={launching || gameRunning}
                >
                  {launching ? '指令发送中…' : gameRunning ? '电脑端游戏运行中' : remoteMode ? '📡 局域网串流启动' : '🚀 一键启动'}
                </button>
                <div className="text-xs text-slate-600 leading-relaxed">
                  {remoteMode
                    ? <>启动指令将发送给电脑端 MC-Next（设置页可配置 IP），<br />由电脑实际运行游戏并自动补全依赖，手机全程遥控</>
                    : <>启动后将自动补全缺失依赖库（多源降级：官方 → BMCLAPI）<br />首次启动需要下载 assets 资源索引，请耐心等待</>}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-600">请选择一个版本</div>
          )}
        </div>
      </div>
    </div>
  )
}
