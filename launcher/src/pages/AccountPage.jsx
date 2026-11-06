import React, { useState, useEffect } from 'react'
import { RELEASE, openDownload } from '../lib/release.js'

const api = () => window.mcnext

/** 模块二：微软正版 OAuth2（设备码流程）+ Authlib-Injector 第三方认证 */
export default function AccountPage() {
  const [accounts, setAccounts] = useState([])
  const [device, setDevice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [root, setRoot] = useState('https://littleskin.cn/api/yggdrasil')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [args, setArgs] = useState(null)

  const reload = () => api()?.authList().then(setAccounts).catch(e => setMsg({ ok: false, text: e.message }))
  useEffect(() => { reload() }, [])

  const startMs = async () => {
    setBusy(true); setMsg(null)
    try {
      const d = await api().authDeviceStart()
      setDevice(d)
      openDownload(d.verificationUri)
    } catch (e) { setMsg({ ok: false, text: `微软设备码申请失败：${e.message}` }) }
    finally { setBusy(false) }
  }

  const completeMs = async () => {
    if (!device) return
    setBusy(true)
    setMsg({ ok: true, text: '等待微软授权完成（最多 15 分钟），请在浏览器中确认…' })
    try {
      const a = await api().authDeviceComplete(device.id)
      setMsg({ ok: true, text: `✓ 已登录正版账号 ${a.name}` })
      setDevice(null); reload()
    } catch (e) { setMsg({ ok: false, text: `登录失败：${e.message}` }) }
    finally { setBusy(false) }
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
          <div className="text-sm font-medium text-accent mb-1">🪟 微软正版登录（OAuth2 设备码）</div>
          <p className="text-xs text-slate-500 mb-4 leading-relaxed">
            走 login.microsoftonline.com → XBL → XSTS → Minecraft Services 全链路，令牌本地加密持久化。
            需设备已联网；微软客户端 ID 可通过环境变量 MCNEXT_MS_CLIENT_ID 覆盖。
          </p>
          {!device ? (
            <button className="btn-primary text-sm" onClick={startMs} disabled={busy}>发起设备码登录</button>
          ) : (
            <div className="space-y-3">
              <div className="bg-base-900/70 border border-accent/20 rounded-xl p-4 text-center">
                <div className="text-xs text-slate-500 mb-1">在浏览器打开 {device.verificationUri} 并输入</div>
                <div className="text-3xl font-mono tracking-[0.3em] text-accent">{device.userCode}</div>
                <div className="text-[11px] text-slate-600 mt-2">有效期 {device.expiresIn} 秒</div>
              </div>
              <div className="flex gap-2">
                <button className="btn-primary text-sm" onClick={completeMs} disabled={busy}>我已完成授权</button>
                <button className="btn-ghost text-sm" onClick={() => setDevice(null)}>取消</button>
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
        <button className="text-accent underline ml-1" onClick={() => openDownload(RELEASE.appImage)}>{RELEASE.appImage}</button>
      </div>
    </div>
  )
}
