import React, { useState, useEffect, useRef } from 'react'
import { api, isMobile, getPC, setPC, remoteApi, launchExternalApp, isAppInstalled, MC_LAUNCHERS } from '@/services'
import { RELEASE, openDownload } from '@/lib/release.js'

/** 真实 GitHub Release 绝对下载地址 + 移动端 launch.json 导出 */
function DownloadCard({ settings }) {
  const [result, setResult] = useState(null)
  const [cfg, setCfg] = useState({
    version: '1.20.1',
    mainClass: 'net.minecraft.client.main.Main',
    classpath: '',
    gameDir: '/storage/emulated/0/MC-Next/instances/default/.minecraft',
    assetsDir: '/storage/emulated/0/MC-Next/assets',
    assetIndex: '5',
    username: settings?.playerName || 'Player',
    uuid: '00000000000000000000000000000000',
    accessToken: '',
    renderer: 'gl4es',
    width: 1280, height: 720, maxMemoryMb: 2048, minMemoryMb: 512
  })
  const set = (k, v) => setCfg(c => ({ ...c, [k]: v }))
  const items = [
    { label: 'Linux AppImage', official: RELEASE.appImage, url: RELEASE.mirrorAppImage, note: '双击运行（需 FUSE）' },
    { label: 'Linux tar.gz', official: RELEASE.tarGz, url: RELEASE.mirrorTarGz, note: '绿色解压版' },
    { label: 'Android 原生 APK', official: RELEASE.apk, url: RELEASE.mirrorApk, note: '内置 JRE 17 + GL4ES' },
    { label: '源码 tar.gz', official: RELEASE.source, url: RELEASE.mirrorSource, note: '完整工程' }
  ]
  const doExport = async () => {
    try {
      const r = await api.mobileExport(cfg)
      setResult(r.ok ? { ok: true, text: `已导出 ${r.path}` } : { ok: false, text: r.error })
    } catch (e) { setResult({ ok: false, text: e.message }) }
  }

  return (
    <>
      <div className="glass-panel p-6 max-w-3xl border-accent/20">
        <div className="text-sm font-medium text-accent mb-1">⬇️ 下载客户端（GitHub Release 真实直链）</div>
        <p className="text-xs text-slate-500 mb-4 leading-relaxed">
          全部为绝对 https 地址。<b className="text-accent">「加速下载」默认走 gh-proxy 镜像</b>（实测四个资源均返回 206 可下载），
          「官方直链」为 GitHub Release 原地址（国内网络可能挂起，可复制后用其他工具下载）。
          Release 页面：
          <button className="text-accent underline ml-1" onClick={() => openDownload(RELEASE.page)}>{RELEASE.page}</button>
        </p>
        <div className="space-y-2">
          {items.map(it => (
            <div key={it.label} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 bg-base-900/50 border border-white/5 rounded-xl px-4 py-2.5">
              <span className="text-sm text-slate-200 w-40 shrink-0">{it.label}</span>
              <button className="btn-primary text-xs px-3 py-1.5 shrink-0" onClick={() => openDownload(it.url)}>加速下载</button>
              <button className="btn-ghost text-xs px-3 py-1.5 shrink-0" onClick={() => openDownload(it.official)}>官方直链</button>
              <span className="text-[10px] font-mono text-slate-500 break-all flex-1">{it.official}</span>
              <span className="text-[10px] text-slate-600 shrink-0">{it.note}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="glass-panel p-6 max-w-3xl">
        <div className="text-sm font-medium text-slate-300 mb-1">📱 导出移动端启动配置（launch.json）</div>
        <p className="text-xs text-slate-500 mb-4">
          Android 原生端不含 WebView，启动前需读取 launch.json。请把 classpath 填成手机上的真实路径
          （游戏 Jar + 全部依赖库，以 : 分隔），导出后把文件放到 Android/data/com.mcnext.launcher/files/ 下。
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {[
            ['version', 'MC 版本'], ['mainClass', '主类'], ['gameDir', '游戏目录'],
            ['assetsDir', '资源目录'], ['username', '玩家名'], ['renderer', '渲染后端']
          ].map(([k, label]) => (
            <label key={k} className="text-[11px] text-slate-500">{label}
              <input className="block mt-1 w-full bg-base-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono outline-none focus:border-accent/50"
                     value={cfg[k]} onChange={e => set(k, e.target.value)} />
            </label>
          ))}
        </div>
        <label className="block text-[11px] text-slate-500 mt-2">Classpath（必填）
          <input className="block mt-1 w-full bg-base-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono outline-none focus:border-accent/50"
                 placeholder="/sdcard/MC-Next/1.20.1.jar:/sdcard/MC-Next/libraries/a.jar"
                 value={cfg.classpath} onChange={e => set('classpath', e.target.value)} />
        </label>
        <div className="flex items-center gap-3 mt-3">
          <button className="btn-primary text-sm" onClick={doExport} disabled={!cfg.classpath}>导出 launch.json</button>
          {result && <span className={`text-xs ${result.ok ? 'text-mc-green' : 'text-mc-red'}`}>{result.text}</span>}
        </div>
      </div>
    </>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className="flex items-start gap-6 py-4 border-b border-white/5 last:border-0">
      <div className="w-40 shrink-0 text-sm text-slate-400">{label}</div>
      <div className="flex-1">{children}</div>
      {hint && <div className="text-xs text-slate-600 mt-1">{hint}</div>}
    </div>
  )
}

export default function SettingsPage({ settings, setSettings }) {
  const [saved, setSaved] = useState(false)
  // 0.9.0 模块二C：保存提示的延时器集中管理，卸载时清理，避免卸载后 setState 与定时器残留
  const savedTimer = useRef(null)
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])
  const markSaved = () => {
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 1500)
  }
  const [pcInput, setPcInput] = useState(getPC())
  const [pcTest, setPcTest] = useState(null)
  const [launcherStates, setLauncherStates] = useState({})
  // 0.5.0 模块一：动态背景 / 极客 JVM 面板
  const [profiles, setProfiles] = useState([])
  const [preview, setPreview] = useState(null)
  const [bgBusy, setBgBusy] = useState(false)
  const [bgMsg, setBgMsg] = useState(null)
  const [memCustom, setMemCustom] = useState('')
  const [memMsg, setMemMsg] = useState(null)
  // 0.6.0 模块三：极客一键调优
  const [tune, setTune] = useState(null)
  const [tuneBusy, setTuneBusy] = useState(false)
  const [tuneApplied, setTuneApplied] = useState(false)
  const mobile = isMobile

  useEffect(() => {
    if (!mobile) return
    // 检测手机上已安装的第三方启动器
    for (const l of MC_LAUNCHERS) {
      isAppInstalled(l.pkg).then(ok => setLauncherStates(p => ({ ...p, [l.pkg]: ok })))
    }
  }, [])

  const testPC = async () => {
    setPC(pcInput)
    setPcTest({ loading: true })
    try {
      const r = await remoteApi.status()
      setPcTest({ ok: true, text: `已连接 ${r.app} v${r.version} · 游戏${r.running ? '运行中' : '未运行'} · 电脑IP: ${(r.ips || []).join(', ') || 'localhost'}` })
    } catch (e) {
      setPcTest({ ok: false, text: e.message })
    }
  }

  const openLauncher = async (pkg) => {
    try {
      await launchExternalApp(pkg)
    } catch (e) {
      setPcTest({ ok: false, text: `唤起失败: ${e.message}` })
    }
  }
  const s = { javaPath: 'java', minMemory: '1G', maxMemory: '4G', playerName: 'Player', serverMemory: 4, ...settings }

  const update = (k, v) => {
    setSettings({ ...s, [k]: v })
    markSaved()
  }
  const updateMany = (patch) => {
    setSettings({ ...s, ...patch })
    markSaved()
  }

  /** 0.6.0 模块三：按本机物理内存生成最优 JVM 参数（真实 os.totalmem，不是写死数值） */
  const runTune = async () => {
    setTuneBusy(true); setTuneApplied(false)
    try {
      const a = api
      if (!a || typeof a.jvmRecommend !== 'function') { setTune({ ok: false, error: '当前环境不支持 JVM 调优' }); return }
      setTune(await a.jvmRecommend())
    } catch (e) { setTune({ ok: false, error: e.message }) }
    finally { setTuneBusy(false) }
  }
  const applyTune = () => {
    if (!tune || !tune.ok) return
    updateMany({
      jvmProfileId: tune.profileId,
      minMemory: tune.minMemory,
      maxMemory: tune.maxMemory,
      extraJvmArgsText: tune.argsText
    })
    setTuneApplied(true)
  }

  // 动态背景配置（归一化默认值）
  const bg = {
    mode: 'dark', particleCount: 72, particleSpeed: 0.6, blur: 14,
    overlayOpacity: 0.55, particleColor: '#5b9dff', imageDataUrl: null,
    ...(settings.background || {})
  }
  const updateBg = (patch) => updateMany({ background: { ...bg, ...patch } })

  // 加载推荐 JVM 预设 + 实时预览最终启动参数
  useEffect(() => {
    const a = api
    if (!a || !a.jvmProfiles) return
    a.jvmProfiles().then(setProfiles).catch(() => {})
  }, [])
  useEffect(() => {
    const a = api
    if (!a || !a.jvmPreview) return
    let alive = true
    a.jvmPreview({
      profileId: s.jvmProfileId || null,
      extraJvmArgsText: s.extraJvmArgsText || '',
      minMemory: s.minMemory, maxMemory: s.maxMemory
    }).then(r => { if (alive) setPreview(r) }).catch(() => {})
    return () => { alive = false }
  }, [s.jvmProfileId, s.extraJvmArgsText, s.minMemory, s.maxMemory])

  const pickBg = async () => {
    setBgBusy(true); setBgMsg(null)
    try {
      const r = await api.appearancePickImage()
      if (r.ok) {
        updateBg({ mode: 'image', imageDataUrl: r.dataUrl })
        setBgMsg({ ok: true, text: `已应用 ${r.sourceName}（${r.mime}${r.width ? ` · ${r.width}×${r.height}` : ''} · ${(r.size / 1024).toFixed(0)}KB）` })
      } else setBgMsg({ ok: false, text: r.error })
    } catch (e) { setBgMsg({ ok: false, text: e.message }) }
    finally { setBgBusy(false) }
  }

  const applyMem = () => {
    const v = memCustom.trim()
    if (!/^\d+(?:\.\d+)?[KMGkmg]$/.test(v)) { setMemMsg('格式不合法：应为数字 + K/M/G，例如 6G 或 8192M'); return }
    update('maxMemory', v)
    setMemCustom(''); setMemMsg(null)
  }

  const fillRecommended = () => {
    const p = profiles.find(x => x.id === (s.jvmProfileId || 'g1')) || profiles[0]
    if (!p) return
    updateMany({ extraJvmArgsText: p.args.join('\n'), jvmProfileId: null })
  }

  return (
    <div className="h-full flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">设置</h1>
        <p className="text-sm text-slate-500 mt-1">所有设置自动保存到本地</p>
      </header>

      <div className="glass-panel p-6 max-w-3xl">
        <Field label="Java 路径" hint="默认使用系统 PATH 中的 java；可指定完整路径如 /usr/lib/jvm/zulu21/bin/java">
          <input
            className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
            value={s.javaPath}
            onChange={e => update('javaPath', e.target.value)}
          />
        </Field>
        <Field label="最小内存 (-Xms)">
          <div className="flex gap-2">
            {['512M', '1G', '2G'].map(v => (
              <button key={v} className={`btn text-xs ${s.minMemory === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => update('minMemory', v)}>{v}</button>
            ))}
          </div>
        </Field>
        <Field label="最大内存 (-Xmx)" hint="也可自定义，如 6G / 8192M">
          <div className="flex flex-wrap gap-2 items-center">
            {['2G', '4G', '8G', '16G'].map(v => (
              <button key={v} className={`btn text-xs ${s.maxMemory === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => update('maxMemory', v)}>{v}</button>
            ))}
            <input
              className="bg-base-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono w-24 outline-none focus:border-accent/50"
              placeholder="自定义 6G" value={memCustom} onChange={e => setMemCustom(e.target.value)}
            />
            <button className="btn-ghost text-xs" onClick={applyMem}>应用</button>
            {memMsg && <span className="text-[11px] text-mc-red">{memMsg}</span>}
          </div>
        </Field>
        <Field label="玩家名称" hint="离线模式使用；正版 Microsoft 登录为框架级能力">
          <input
            className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm outline-none focus:border-accent/50"
            value={s.playerName}
            onChange={e => update('playerName', e.target.value)}
          />
        </Field>
        <Field label="服务端默认内存">
          <div className="flex items-center gap-3">
            <input
              type="range" min="1" max="16" step="1"
              value={s.serverMemory}
              onChange={e => update('serverMemory', Number(e.target.value))}
              className="flex-1 accent-accent"
            />
            <span className="font-mono text-accent w-12 text-right">{s.serverMemory}G</span>
          </div>
        </Field>
        <Field label="界面主题" hint="夜间护眼模式降低蓝光、压低纯黑对比并暖化文本，适合深夜游玩">
          <div className="flex gap-2">
            <button className={`btn text-xs ${!s.theme || s.theme === 'dark' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => update('theme', 'dark')}>深色</button>
            <button className={`btn text-xs ${s.theme === 'midnight' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => update('theme', 'midnight')}>🌙 夜间护眼</button>
          </div>
        </Field>
      </div>

      {/* 0.5.0 模块一：动态背景引擎 */}
      <div className="glass-panel p-6 max-w-3xl border-accent/20">
        <div className="text-sm font-medium text-accent mb-1">✨ 动态背景引擎</div>
        <p className="text-xs text-slate-500 mb-3">
          深色极简 / 动态粒子（Wallpaper Engine 风）/ 本地图片 + 高斯模糊 + 毛玻璃遮罩。设置即时生效并持久化。
        </p>
        <Field label="背景模式">
          <div className="flex flex-wrap gap-2">
            {[['dark', '🌑 深色极简'], ['particles', '✦ 动态粒子'], ['image', '🖼 本地图片']].map(([m, label]) => (
              <button key={m} className={`btn text-xs ${bg.mode === m ? 'btn-primary' : 'btn-ghost'}`} onClick={() => updateBg({ mode: m })}>{label}</button>
            ))}
            <button className="btn-ghost text-xs" onClick={pickBg} disabled={bgBusy}>{bgBusy ? '读取中…' : '⬆ 上传本地图片'}</button>
          </div>
        </Field>
        {bgMsg && <div className={`text-xs mt-2 ${bgMsg.ok ? 'text-mc-green' : 'text-mc-red'}`}>{bgMsg.ok ? '✓ ' : '✗ '}{bgMsg.text}</div>}
        {bg.mode === 'image' && (
          <>
            <Field label={`高斯模糊 · ${bg.blur}px`}>
              <input type="range" min="0" max="40" value={bg.blur} onChange={e => updateBg({ blur: Number(e.target.value) })} className="w-full accent-accent" />
            </Field>
            <Field label={`毛玻璃遮罩 · ${Math.round(bg.overlayOpacity * 100)}%`}>
              <input type="range" min="10" max="90" value={Math.round(bg.overlayOpacity * 100)} onChange={e => updateBg({ overlayOpacity: Number(e.target.value) / 100 })} className="w-full accent-accent" />
            </Field>
            {bg.imageDataUrl && (
              <div className="flex items-center gap-3 mt-2">
                <img src={bg.imageDataUrl} alt="背景预览" className="w-28 h-16 object-cover rounded-lg border border-white/10" style={{ filter: `blur(${Math.min(bg.blur, 4)}px)` }} />
                <span className="text-[11px] text-slate-500">当前背景预览</span>
                <button className="btn-ghost text-xs" onClick={() => updateBg({ imageDataUrl: null, mode: 'dark' })}>清除图片</button>
              </div>
            )}
            {!bg.imageDataUrl && <div className="text-[11px] text-mc-gold mt-2">尚未选择图片，请点击「上传本地图片」（仅 PNG/JPEG/WebP/GIF，≤12MB）</div>}
          </>
        )}
        {bg.mode === 'particles' && (
          <Field label={`粒子数量 · ${bg.particleCount}`}>
            <input type="range" min="20" max="200" value={bg.particleCount} onChange={e => updateBg({ particleCount: Number(e.target.value) })} className="w-full accent-accent" />
            <div className="text-[11px] text-slate-600 mt-1">Canvas 实时绘制粒子漂移与近邻连线；系统开启「减少动态效果」时自动降为静态</div>
          </Field>
        )}
      </div>

      {/* 0.6.0 模块三：极客一键调优 */}
      <div className="glass-panel p-6 max-w-3xl border-mc-green/20">
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium text-slate-300">🚀 极客一键调优（按物理内存自动生成）</div>
          <button className="btn-primary text-xs" onClick={runTune} disabled={tuneBusy}>
            {tuneBusy ? '检测中…' : '检测并生成最优参数'}
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-3 leading-relaxed">
          读取本机真实物理内存（os.totalmem），按 35% / 45% / 50% 分档计算 Xmx·Xms，套用真实可用的 Aikar 系 G1GC 参数，
          经参数校验去重后<b className="text-slate-300">直接写入启动指令</b>（下次启动生效）。不会替你猜硬件、不会写死 4G。
        </p>
        {tune && !tune.ok && <div className="text-xs text-mc-red">调优失败：{tune.error || '参数校验未通过'}</div>}
        {tune && tune.ok && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                ['物理内存', `${tune.totalMemMb} MB`],
                ['推荐 Xmx', tune.maxMemory],
                ['推荐 Xms', tune.minMemory],
                ['G1 参数', `${tune.args.length} 个`]
              ].map(([k, v]) => (
                <div key={k} className="bg-base-900/60 border border-white/5 rounded-xl px-3 py-2">
                  <div className="text-[10px] text-slate-600">{k}</div>
                  <div className="text-sm font-mono text-accent">{v}</div>
                </div>
              ))}
            </div>
            <ul className="text-[11px] text-slate-500 space-y-0.5">
              {tune.notes.map((n, i) => <li key={i}>· {n}</li>)}
            </ul>
            <div className="flex items-center gap-2">
              <button className="btn-primary text-xs" onClick={applyTune}>⚡ 写入启动指令</button>
              {tuneApplied && <span className="text-[11px] text-mc-green">✓ 已写入设置，下次启动生效（内存与参数均已同步）</span>}
            </div>
          </div>
        )}
      </div>

      {/* 0.5.0 模块一：极客自定义面板（JVM 启动参数） */}
      <div className="glass-panel p-6 max-w-3xl">
        <div className="text-sm font-medium text-slate-300 mb-1">🛠 极客自定义面板 · JVM 启动参数</div>
        <p className="text-xs text-slate-500 mb-3">
          自定义 <span className="font-mono text-accent">-XX</span> / <span className="font-mono text-accent">-D</span> 参数；
          <span className="font-mono">-Xmx/-Xms</span> 由上方内存设置统一托管（文本内书写会被自动忽略以避免冲突）。点「推荐配置」一键填入真实可用的 G1GC 参数。
        </p>
        <div className="flex flex-wrap gap-2 mb-3">
          {profiles.map(p => (
            <button key={p.id} title={p.desc}
              className={`btn text-xs ${s.jvmProfileId === p.id ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => updateMany({ jvmProfileId: p.id, minMemory: p.minMemory, maxMemory: p.maxMemory })}>
              {p.name}
            </button>
          ))}
          <button className="btn-primary text-xs" onClick={fillRecommended}>⚡ 一键填入推荐配置</button>
          <button className="btn-ghost text-xs" onClick={() => updateMany({ jvmProfileId: null, extraJvmArgsText: '' })}>清空</button>
        </div>
        <textarea
          rows={6} spellCheck={false}
          className="w-full bg-base-900/60 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono outline-none focus:border-accent/50 leading-relaxed"
          placeholder={'-XX:+UseG1GC\n-XX:MaxGCPauseMillis=200\n-Dfml.readTimeout=60   # 支持 # 行内注释'}
          value={s.extraJvmArgsText || ''}
          onChange={e => update('extraJvmArgsText', e.target.value)}
        />
        {preview && (
          <div className="mt-3 text-[11px] space-y-0.5">
            <div className={preview.ok ? 'text-mc-green' : 'text-mc-red'}>
              {preview.ok ? '✓' : '✗'} 最终生效 {preview.jvmArgs.length} 个 JVM 参数 · 内存 {preview.minMemory} – {preview.maxMemory}
              {preview.profileId ? ` · 预设 ${preview.profileId}` : ''}
            </div>
            {(preview.issues || []).map((it, i) => (
              <div key={i} className={it.severity === 'error' ? 'text-mc-red' : 'text-mc-gold'}>· {it.message}</div>
            ))}
          </div>
        )}
      </div>

      <DownloadCard settings={settings} />

      {mobile && (
        <>
          <div className="glass-panel p-6 max-w-3xl border-accent/20">
            <div className="text-sm font-medium text-accent mb-1">📡 远程控制（局域网串流）</div>
            <p className="text-xs text-slate-500 mb-4">输入同一 WiFi 下电脑的 IP（电脑端需打开 MC-Next 桌面版），即可用手机遥控电脑启动游戏</p>
            <Field label="电脑 IP 地址" hint="例如 192.168.1.100（电脑端会监听 25300 端口）">
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
                  placeholder="192.168.1.100"
                  value={pcInput}
                  onChange={e => setPcInput(e.target.value)}
                />
                <button className="btn-primary text-sm px-5 shrink-0" onClick={testPC} disabled={pcTest?.loading}>
                  {pcTest?.loading ? '测试中…' : '测试连接'}
                </button>
              </div>
            </Field>
            {pcTest && !pcTest.loading && (
              <div className={`mt-3 text-xs px-3 py-2 rounded-lg border ${pcTest.ok ? 'border-mc-green/30 text-mc-green bg-mc-green/5' : 'border-mc-red/30 text-mc-red bg-mc-red/5'}`}>
                {pcTest.ok ? '✓ ' : '✗ '}{pcTest.text}
              </div>
            )}
          </div>

          <div className="glass-panel p-6 max-w-3xl">
            <div className="text-sm font-medium text-accent mb-1">📱 唤起本机 MC 启动器</div>
            <p className="text-xs text-slate-500 mb-4">通过 Android Intent 协议直接唤起手机上已安装的 Java 版启动器（未安装会跳转应用商店）</p>
            <div className="flex flex-wrap gap-2">
              {MC_LAUNCHERS.map(l => (
                <button
                  key={l.pkg}
                  className={`btn text-xs ${launcherStates[l.pkg] ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => openLauncher(l.pkg)}
                >
                  {launcherStates[l.pkg] === true ? '● ' : launcherStates[l.pkg] === false ? '○ ' : ''}{l.name}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-slate-600 mt-3">● 已检测安装 · ○ 未检测到（点击将跳转商店） · 点击任意按钮尝试唤起</div>
          </div>
        </>
      )}

      <div className="glass-panel p-6 max-w-3xl">
        <div className="text-sm font-medium text-slate-400 mb-3">本地仓库路径</div>
        <div className="space-y-2 text-xs font-mono">
          <div className="flex justify-between"><span className="text-slate-500">客户端</span><span className="text-slate-400">/workspace/MC正式版客户端</span></div>
          <div className="flex justify-between"><span className="text-slate-500">服务端</span><span className="text-slate-400">/workspace/MC正式版服务端</span></div>
          <div className="flex justify-between"><span className="text-slate-500">模组加载器</span><span className="text-slate-400">/workspace/模组加载器</span></div>
          <div className="flex justify-between"><span className="text-slate-500">依赖库</span><span className="text-slate-400">~/.mc-next/libraries</span></div>
          <div className="flex justify-between"><span className="text-slate-500">游戏目录</span><span className="text-slate-400">~/.mc-next/game</span></div>
        </div>
      </div>

      {saved && (
        <div className="fixed bottom-6 right-6 glass-panel px-4 py-2 text-sm text-mc-green border-mc-green/30 animate-fade-in">
          ✓ 已保存
        </div>
      )}
    </div>
  )
}
