import React, { useState, useEffect } from 'react'
import { isMobile, getPC, setPC, remoteApi, launchExternalApp, isAppInstalled, MC_LAUNCHERS } from '../lib/remote.js'
import { RELEASE, openDownload } from '../lib/release.js'

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
      const r = await window.mcnext.mobileExport(cfg)
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
  const [pcInput, setPcInput] = useState(getPC())
  const [pcTest, setPcTest] = useState(null)
  const [launcherStates, setLauncherStates] = useState({})
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
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
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
        <Field label="最大内存 (-Xmx)">
          <div className="flex gap-2">
            {['2G', '4G', '8G', '16G'].map(v => (
              <button key={v} className={`btn text-xs ${s.maxMemory === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => update('maxMemory', v)}>{v}</button>
            ))}
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
