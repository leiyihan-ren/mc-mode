import React, { useState, useEffect } from 'react'
import { RELEASE, openDownload } from '../lib/release.js'

const api = () => window.mcnext

const STATE_TEXT = {
  pending: '等待开始',
  polling: '后台轮询授权中…',
  authorizing: '正在换取 Xbox / Minecraft 令牌…',
  success: '✓ 授权成功',
  error: '授权失败',
  expired: '设备码已过期',
  cancelled: '已取消'
}

/** 0.6.0 模块二：微软 OAuth2 设备码真流程 + Authlib-Injector 第三方认证 */
export default function AccountPage() {
  const [accounts, setAccounts] = useState([])
  const [device, setDevice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [demo, setDemo] = useState(false)
  const [copied, setCopied] = useState(false)
  const [root, setRoot] = useState('https://littleskin.cn/api/yggdrasil')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [args, setArgs] = useState(null)

  const reload = () => api()?.authList().then(setAccounts).catch(e => setMsg({ ok: false, text: e.message }))
  useEffect(() => { reload() }, [])

  // 主进程后台轮询的状态推送（IPC 事件）
  useEffect(() => {
    const a = api()
    if (!a || typeof a.onAuthDevice !== 'function') return
    const off = a.onAuthDevice((v) => {
      setDevice(prev => (prev && v && v.id === prev.id ? { ...prev, ...v } : prev))
    })
    return () => { try { off && off() } catch { /* noop */ } }
  }, [])

  // 兜底轮询：事件丢失（如 Capacitor 远程通道）时也能拿到状态
  useEffect(() => {
    if (!device || !['polling', 'authorizing'].includes(device.state)) return
    const iv = setInterval(async () => {
      try {
        const s = await api().authDeviceStatus(device.id)
        setDevice(prev => (prev && s && s.id === prev.id ? { ...prev, ...s } : prev))
      } catch { /* 状态查询失败不打断 UI */ }
    }, 1200)
    return () => clearInterval(iv)
  }, [device?.id, device?.state])

  useEffect(() => {
    if (device && device.state === 'success' && device.account) {
      setMsg({
        ok: true,
        text: `✓ 已登录 ${device.account.name}${device.mock ? '（演示模式 · 非真实正版账号）' : '（微软正版）'}，主页已展示玩家卡片`
      })
      reload()
    }
  }, [device?.state])

  const startMs = async () => {
    setBusy(true); setMsg(null); setCopied(false)
    try {
      // 真实模式不传参 → 请求 login.microsoftonline.com；demo 明确走协议级 Mock
      const d = await api().authDeviceStart(demo ? { mock: true } : {})
      setDevice(d)
    } catch (e) {
      setMsg({ ok: false, text: `微软设备码申请失败：${e.message}${demo ? '' : '（请确认本机可访问 login.microsoftonline.com，或勾选离线演示）'}` })
    } finally { setBusy(false) }
  }

  /** 用户要求的「点击复制并打开浏览器」：复制 user_code + 打开验证页 + 启动后台死循环轮询 */
  const copyAndOpen = async () => {
    if (!device) return
    const code = device.userCode || ''
    let ok = false
    try { await navigator.clipboard.writeText(code); ok = true } catch { /* 非安全上下文降级 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select()
        ok = document.execCommand('copy')
        document.body.removeChild(ta)
      } catch { ok = false }
    }
    setCopied(ok)
    openDownload(device.verificationUriComplete || device.verificationUri)
    try {
      const s = await api().authDeviceBegin(device.id)
      setDevice(prev => ({ ...prev, ...s }))
      setMsg({ ok: true, text: ok ? '验证码已复制，浏览器已打开；后台正在轮询授权结果…' : '浏览器已打开（复制失败请手动选中验证码）；后台正在轮询…' })
    } catch (e) {
      setMsg({ ok: false, text: `后台轮询启动失败：${e.message}` })
    }
  }

  const cancelMs = async () => {
    try { await api().authDeviceCancel(device?.id) } catch { /* noop */ }
    setDevice(null); setCopied(false)
  }

  const loginAuthlib = async () => {
    setBusy(true); setMsg(null)
    try {
      const a = await api().authlibLogin({ apiRoot: root, username: user, password: pass })
      setMsg({ ok: true, text: `✓ 已登录 ${a.name}（${a.apiRoot}）` })
      setPass(''); reload()
    } catch (e) { setMsg({ ok: false, text: `第三方认证失败：${e.message}` }) }
    finally { setBusy(false) }
  }

  const showArgs = async uuid => {
    try { setArgs((await api().authLaunchArgs(uuid)).join(' ')) }
    catch (e) { setMsg({ ok: false, text: e.message }) }
  }

  const running = device && ['polling', 'authorizing'].includes(device.state)

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-5 pb-8">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">账号中心</h1>
        <p className="text-sm text-slate-500 mt-1">微软正版 OAuth2 设备码 · Authlib-Injector 第三方皮肤站 · 启动参数直出</p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.ok ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>
          {msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <section className="glass-panel p-5">
          <div className="flex items-center justify-between mb-1">
            <div className="text-sm font-medium text-accent">🪟 微软正版登录（OAuth2 设备码 · 真流程）</div>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer select-none">
              <input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> 离线演示
            </label>
          </div>
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            login.microsoftonline.com 设备码 → XBL → XSTS → Minecraft Services → 正版档案（皮肤 / UUID / 名字）。
            拿到 user_code 后点击按钮自动复制并打开浏览器，主进程<b className="text-slate-300">后台死循环轮询</b>，界面不卡顿；令牌仅存本地且不出主进程。
          </p>
          {demo && (
            <div className="text-[11px] text-mc-gold border border-mc-gold/25 bg-mc-gold/5 rounded-lg px-3 py-2 mb-3 leading-relaxed">
              ⚠ 演示模式：用协议级 Mock 完整模拟六步链路（含 pending / slow_down），<b>不产生真实正版账号</b>，账号写入独立 demo 仓库。
              真实环境请取消勾选并联网使用。
            </div>
          )}
          {!device ? (
            <button className="btn-primary text-sm" onClick={startMs} disabled={busy}>
              {demo ? '发起演示设备码登录' : '发起设备码登录'}
            </button>
          ) : (
            <div className="space-y-3">
              <div className="bg-base-900/70 border border-accent/20 rounded-xl p-4 text-center">
                <div className="text-xs text-slate-500 mb-1">
                  在浏览器打开 {device.verificationUri} 并输入
                </div>
                <div className="text-3xl font-mono tracking-[0.3em] text-accent select-all">{device.userCode}</div>
                <div className="text-[11px] text-slate-600 mt-2">有效期 {device.expiresIn} 秒 · 轮询间隔 {device.interval} 秒</div>
              </div>

              <button className="btn-primary text-sm w-full" onClick={copyAndOpen} disabled={busy || running}>
                📋 复制验证码并打开浏览器
              </button>
              {copied && <div className="text-[11px] text-mc-green -mt-2">✓ 验证码已复制到剪贴板</div>}

              <div className="bg-base-900/50 border border-white/5 rounded-xl px-3 py-2.5 text-[11px] space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">状态</span>
                  <span className={device.state === 'success' ? 'text-mc-green' : device.state === 'error' || device.state === 'expired' ? 'text-mc-red' : 'text-accent'}>
                    {STATE_TEXT[device.state] || device.state}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-600">
                  <span>轮询次数 {device.pollCount || 0}</span>
                  <span>已用时 {Math.round((device.elapsedMs || 0) / 1000)}s</span>
                </div>
                {device.error && <div className="text-mc-red break-words pt-1 border-t border-white/5 mt-1">{device.error}</div>}
                {device.state === 'success' && device.account && (
                  <div className="text-mc-green pt-1 border-t border-white/5 mt-1">
                    {device.account.name} · {device.account.uuid}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                {device.state === 'success' ? (
                  <button className="btn-primary text-sm" onClick={() => { setDevice(null); setCopied(false); reload() }}>完成</button>
                ) : (
                  <button className="btn-ghost text-sm" onClick={cancelMs}>取消登录</button>
                )}
                {(device.state === 'expired' || device.state === 'error') && (
                  <button className="btn-ghost text-sm" onClick={() => { setDevice(null); setCopied(false); startMs() }}>重新发起</button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="glass-panel p-5">
          <div className="text-sm font-medium text-accent mb-1">🧩 Authlib-Injector（LittleSkin 等）</div>
          <p className="text-xs text-slate-500 mb-4 leading-relaxed">
            通过 Yggdrasil API 完成 authenticate，并生成 -javaagent:authlib-injector 与
            -Dauthlibinjector.yggdrasil.prefetched 启动参数，无缝接入第三方皮肤站。
          </p>
          <div className="space-y-2">
            <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
                   value={root} onChange={e => setRoot(e.target.value)} placeholder="API Root" />
            <div className="flex gap-2">
              <input className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm outline-none focus:border-accent/50"
                     value={user} onChange={e => setUser(e.target.value)} placeholder="邮箱 / 用户名" />
              <input type="password" className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm outline-none focus:border-accent/50"
                     value={pass} onChange={e => setPass(e.target.value)} placeholder="密码" />
            </div>
            <button className="btn-primary text-sm" onClick={loginAuthlib} disabled={busy || !user || !pass}>登录第三方账号</button>
          </div>
        </section>
      </div>

      <section className="glass-panel p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-medium text-slate-300">本地账号（{accounts.length}）</div>
          <button className="btn-ghost text-xs" onClick={reload}>刷新</button>
        </div>
        {accounts.length === 0 ? (
          <div className="text-xs text-slate-600 py-6 text-center">暂无账号。离线模式可直接启动，无需登录。</div>
        ) : (
          <div className="space-y-2">
            {accounts.map(a => (
              <div key={a.uuid} className="flex items-center gap-3 bg-base-900/50 border border-white/5 rounded-xl px-4 py-2.5">
                <span className={`tag ${a.type === 'microsoft' ? 'bg-accent/15 text-accent' : 'bg-mc-gold/15 text-mc-gold'}`}>
                  {a.type === 'microsoft' ? '正版' : '外置登录'}
                </span>
                <span className="text-sm text-slate-200 font-medium">{a.name}</span>
                <span className="text-[11px] font-mono text-slate-600">{a.uuid}</span>
                <div className="ml-auto flex gap-2">
                  <button className="btn-ghost text-xs px-3 py-1" onClick={async () => { await api().authSelect(a.uuid); setMsg({ ok: true, text: `已切换当前账号为 ${a.name}` }) }}>设为主页</button>
                  <button className="btn-ghost text-xs px-3 py-1" onClick={() => showArgs(a.uuid)}>启动参数</button>
                  <button className="btn-danger text-xs px-3 py-1" onClick={async () => { await api().authRemove(a.uuid); reload() }}>移除</button>
                </div>
              </div>
            ))}
          </div>
        )}
        {args && (
          <pre className="mt-3 text-[11px] font-mono text-mc-green bg-black/40 border border-white/5 rounded-xl p-3 whitespace-pre-wrap break-all">{args}</pre>
        )}
      </section>

      <div className="text-[11px] text-slate-600">
        未在电脑上本机登录？桌面版直链：
        <button className="text-accent underline ml-1" onClick={() => openDownload(RELEASE.mirrorAppImage)}>{RELEASE.appImage}</button>
      </div>
    </div>
  )
}
