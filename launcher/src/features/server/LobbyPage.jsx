import { api } from '@/services'
import React, { useEffect, useState, useCallback, useRef } from 'react'

/** 模块一 / 模块二（0.4.0）：一键联机大厅 + 真实 P2P 容错
 *  - 创建房间 / 输入邀请码（保留 0.3.0 能力）
 *  - 握手失败（运行超时仍无 peer）自动弹窗，明确提示「请检查防火墙/路由器 UDP 限制」
 *  - 随时可手动打开「真实网络配置向导」：分平台命令、端口、排查步骤、官方文档
 *  - 所有状态来自 easytier-cli 真实输出，不伪造「已连接」
 */
export default function LobbyPage() {
  const [binaries, setBinaries] = useState(null)
  const [mode, setMode] = useState(null) // 'create' | 'join'
  const [inviteCode, setInviteCode] = useState('')
  const [room, setRoom] = useState(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState(null)
  const [rooms, setRooms] = useState([])
  const [mcVersion, setMcVersion] = useState('1.20.1')
  const [msg, setMsg] = useState(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [guide, setGuide] = useState(null)
  const [diagnosis, setDiagnosis] = useState(null)
  const timerRef = useRef(null)
  const autoPromptedRef = useRef(false)

  const refreshBinaries = useCallback(async () => {
    try { setBinaries(await api.lanBinaries()) } catch (e) { setMsg({ type: 'error', text: `读取二进制失败: ${e.message}` }) }
  }, [])
  const refreshRooms = useCallback(async () => {
    try { setRooms(await api.lanListRooms()) } catch { /* noop */ }
  }, [])
  useEffect(() => { refreshBinaries(); refreshRooms() }, [refreshBinaries, refreshRooms])

  const poll = useCallback(async () => {
    try {
      const s = await api.lanStatus()
      setStatus(s)
      setRunning(!!s.running)
      const d = await api.netDiagnose({ status: s })
      setDiagnosis(d)
      // 握手失败达阈值 → 自动弹窗（同一轮联机只弹一次，避免每 3s 骚扰）
      if (d.shouldPrompt && !autoPromptedRef.current) {
        autoPromptedRef.current = true
        setGuideOpen(true)
        setMsg({ type: 'error', text: d.title })
      }
    } catch { /* noop */ }
  }, [])

  useEffect(() => {
    if (running) {
      poll()
      timerRef.current = setInterval(poll, 3000)
      return () => clearInterval(timerRef.current)
    }
    setStatus(null); setDiagnosis(null)
  }, [running, poll])

  const createRoom = async () => {
    setMsg(null)
    try {
      const { room, inviteCode } = await api.lanCreate({ mcVersion })
      setRoom(room); setInviteCode(inviteCode); setMode('create')
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }
  const joinRoom = async () => {
    setMsg(null)
    try {
      const { room, inviteCode } = await api.lanJoin(inviteCode)
      setRoom(room); setMode('join')
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }
  const start = async () => {
    setMsg(null)
    if (!room) return
    autoPromptedRef.current = false
    try {
      const r = await api.lanStart(room, { noTun: true })
      if (r.ok) { setRunning(true); setMsg({ type: 'ok', text: `联机核心已启动（PID ${r.pid}）。虚拟 IP 需稍后由状态面板确认。` }) }
      else setMsg({ type: 'error', text: r.error })
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }
  const stop = async () => {
    try {
      await api.lanStop()
      setRunning(false); setStatus(null); setDiagnosis(null)
      autoPromptedRef.current = false
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }

  const copy = (text, tip) => navigator.clipboard?.writeText(text).then(() => setMsg({ type: 'ok', text: tip || '已复制' }))
  const openGuide = async () => {
    try {
      if (!guide) setGuide(await api.netGuide())
      setGuideOpen(true)
    } catch (e) { setMsg({ type: 'error', text: `读取向导失败：${e.message}` }) }
  }
  const openLink = (url) => api.openExternal(url).catch(() => {})

  // 弹窗内容：优先使用真实诊断结果，手动打开时回落到完整向导
  const steps = diagnosis?.failed && diagnosis.steps?.length ? diagnosis.steps : (guide?.steps || [])
  const commands = diagnosis?.commands || guide?.commands || {}
  const ports = diagnosis?.ports || guide?.ports || []
  const links = diagnosis?.links || guide?.links || []
  const title = diagnosis?.failed ? diagnosis.title : (guide?.title || '真实网络配置向导')
  const summary = diagnosis?.failed ? diagnosis.summary : (guide?.intro || '')

  return (
    <div className="h-full flex flex-col gap-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">一键联机大厅</h1>
          <p className="text-sm text-slate-500 mt-1">基于 EasyTier 真实 P2P 内网穿透：创建房间生成邀请码，好友输入即可加入，无需端口映射</p>
        </div>
        <button className="btn-ghost text-sm shrink-0" onClick={openGuide}>📖 真实网络配置向导</button>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      <div className="glass-panel p-4 flex items-center gap-4 text-sm">
        <span className="text-slate-500">EasyTier 运行时</span>
        {!binaries && <span className="text-slate-400">检测中…</span>}
        {binaries && binaries.verified?.ok && <span className="text-mc-green">✓ {binaries.verified.version}</span>}
        {binaries && !binaries.verified?.ok && (
          <span className="text-mc-red">未就绪：请在 runtime/easytier/easytier-linux-x86_64/ 放置 easytier-core / easytier-cli</span>
        )}
        {binaries && <span className="text-[10px] font-mono text-slate-600 break-all ml-auto">{binaries.core}</span>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 flex-1">
        {/* 创建 / 加入 */}
        <div className="glass-panel p-6 flex flex-col gap-4 overflow-y-auto">
          <div className="flex gap-2">
            <input className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
              value={mcVersion} onChange={e => setMcVersion(e.target.value)} placeholder="房间 MC 版本（可选）" />
          </div>
          <div className="flex gap-2">
            <button className={`btn flex-1 ${mode === 'create' ? 'btn-primary' : 'btn-ghost'}`} onClick={createRoom}>创建房间</button>
            <button className={`btn flex-1 ${mode === 'join' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setMode('join')}>加入房间</button>
          </div>

          {mode === 'join' && (
            <div className="flex flex-col gap-2">
              <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50"
                value={inviteCode} onChange={e => setInviteCode(e.target.value)} placeholder="粘贴好友的邀请码 MCET1.xxxx.yyyy" />
              <button className="btn-primary text-sm" onClick={joinRoom} disabled={!inviteCode}>解析并加入</button>
            </div>
          )}

          {room && (
            <div className="bg-base-900/50 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">角色</span><span className="text-accent">{room.role === 'host' ? '房主' : '成员'}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">网络名</span><span className="font-mono text-xs text-slate-300 break-all">{room.networkName}</span></div>
              {mode === 'create' && inviteCode && (
                <div>
                  <div className="text-slate-500 mb-1">邀请码（含网络密钥，请勿公开张贴）</div>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-base-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-accent break-all select-all">{inviteCode}</code>
                    <button className="btn-ghost text-xs shrink-0" onClick={() => copy(inviteCode, '邀请码已复制')}>复制</button>
                  </div>
                </div>
              )}
              <div className="flex gap-2 pt-1">
                {!running
                  ? <button className="btn-primary text-sm" onClick={start} disabled={binaries && !binaries.verified?.ok}>启动联机</button>
                  : <button className="btn-danger text-sm" onClick={stop}>停止联机</button>}
              </div>
            </div>
          )}

          {rooms.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-slate-500 mb-1">历史房间</div>
              <div className="space-y-1">
                {rooms.slice(0, 5).map((r, i) => (
                  <button key={i} className="w-full text-left text-xs font-mono text-slate-400 hover:text-accent truncate" onClick={() => { setRoom(r); setInviteCode(''); setMode(r.role === 'host' ? 'create' : 'join') }}>
                    {r.role} · {r.networkName} · {r.createdAt?.slice(0, 10)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 状态面板 */}
        <div className="glass-panel p-6 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium text-slate-300">组网状态</div>
            {diagnosis && (
              <span className={`tag ${diagnosis.failed ? 'bg-mc-red/15 text-mc-red' : 'bg-mc-green/15 text-mc-green'}`}>
                {diagnosis.failed ? `未打通 · ${diagnosis.code}` : '已连接'}
              </span>
            )}
            <button className="btn-ghost text-xs ml-auto" onClick={openGuide}>排查向导</button>
          </div>
          {!running && <div className="text-sm text-slate-500">未启动。创建或加入房间后点击「启动联机」。</div>}
          {running && !status && <div className="text-sm text-slate-400">读取状态中…</div>}
          {status && (
            <div className="space-y-3">
              <div className="bg-base-900/50 rounded-xl p-4 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-500">运行状态</span><span className={status.running ? 'text-mc-green' : 'text-slate-400'}>{status.running ? '核心运行中' : '未运行'}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">虚拟 IP</span>
                  <span className={`font-mono ${status.virtualIp ? 'text-accent' : 'text-slate-500'}`}>{status.virtualIp || '尚未分配'}</span></div>
                {status.uptimeMs != null && <div className="flex justify-between"><span className="text-slate-500">运行时长</span><span className="text-slate-400">{Math.round(status.uptimeMs / 1000)}s</span></div>}
                {status.reason && <div className="text-xs text-mc-gold">{status.reason}</div>}
              </div>

              {diagnosis?.failed && (
                <div className="bg-mc-red/5 border border-mc-red/30 rounded-xl p-3 text-xs text-mc-red">
                  <div className="font-medium mb-1">{diagnosis.title}</div>
                  <div className="text-slate-400">{diagnosis.summary}</div>
                  <button className="text-accent hover:underline mt-2" onClick={openGuide}>查看完整排查步骤 →</button>
                </div>
              )}

              <div>
                <div className="text-xs text-slate-500 mb-1">已连接成员（来自 easytier-cli 真实输出）</div>
                {status.peers.length === 0
                  ? <div className="text-xs text-slate-600">暂无其他成员（等待好友用邀请码加入；若长时间无成员请打开排查向导）</div>
                  : <div className="space-y-1">
                    {status.peers.map((p, i) => (
                      <div key={i} className="bg-base-900/50 rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-mc-green" />
                        <span className="font-mono text-slate-300">{p.ipv4 || '—'}</span>
                        <span className="text-slate-500">{p.hostname || ''}</span>
                        {p.cost != null && <span className="text-slate-600 ml-auto">cost {p.cost}</span>}
                      </div>
                    ))}
                  </div>}
              </div>

              {status.logs && status.logs.length > 0 && (
                <div className="bg-base-900/60 rounded-xl p-3 text-[11px] font-mono text-slate-500 max-h-40 overflow-y-auto">
                  {status.logs.slice(-20).map((l, i) => <div key={i}>{l.line}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ===== 真实网络配置向导 / 握手失败弹窗 ===== */}
      {guideOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" onClick={() => setGuideOpen(false)}>
          <div className="glass-panel w-full max-w-3xl max-h-[88vh] overflow-y-auto p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <h2 className={`text-lg font-bold ${diagnosis?.failed ? 'text-mc-red' : 'text-slate-100'}`}>
                  {diagnosis?.failed ? '⚠ ' : '📖 '}{title}
                </h2>
                <p className="text-sm text-slate-400 mt-1">{summary}</p>
              </div>
              <button className="btn-ghost text-xs shrink-0" onClick={() => setGuideOpen(false)}>关闭</button>
            </div>

            {/* 真实状态证据 */}
            {diagnosis && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                {[
                  ['核心进程', diagnosis.evidence.running ? '运行中' : '未运行'],
                  ['虚拟 IP', diagnosis.evidence.virtualIp || '未分配'],
                  ['远端成员', `${diagnosis.evidence.peerCount}`],
                  ['已运行', `${Math.round(diagnosis.elapsedMs / 1000)}s / 阈值 ${Math.round(diagnosis.thresholdMs / 1000)}s`]
                ].map(([k, v]) => (
                  <div key={k} className="bg-base-900/50 rounded-lg px-3 py-2">
                    <div className="text-slate-500">{k}</div>
                    <div className="font-mono text-slate-300 mt-0.5 truncate">{v}</div>
                  </div>
                ))}
              </div>
            )}

            {/* 排查步骤 */}
            {steps.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-slate-200 mb-2">排查步骤（按优先级）</h3>
                <div className="space-y-2">
                  {steps.map((s, i) => (
                    <div key={s.id || i} className={`rounded-xl px-3 py-2 border ${s.focused ? 'border-accent/40 bg-accent/5' : 'border-white/5 bg-base-900/40'}`}>
                      <div className="text-sm text-slate-200"><span className="font-mono text-accent mr-2">{s.n || i + 1}.</span>{s.title}</div>
                      <div className="text-xs text-slate-500 mt-1 pl-5">{s.detail}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 分平台命令 */}
            {Object.keys(commands).length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-slate-200 mb-2">可执行命令（点击复制）</h3>
                <div className="space-y-2">
                  {Object.entries(commands).map(([k, c]) => (
                    <div key={k} className="bg-base-900/60 rounded-xl p-3">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-xs text-slate-400">{c.label}</span>
                        <button className="text-[11px] text-accent hover:underline ml-auto" onClick={() => copy(c.lines.join('\n'), `${c.label} 命令已复制`)}>复制</button>
                      </div>
                      <pre className="text-[11px] font-mono text-slate-400 whitespace-pre-wrap break-all">{c.lines.join('\n')}</pre>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 端口表 */}
            {ports.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-slate-200 mb-2">需要放行的端口</h3>
                <div className="space-y-1">
                  {ports.map((p, i) => (
                    <div key={i} className="flex items-center gap-3 text-xs bg-base-900/40 rounded-lg px-3 py-2">
                      <span className="tag bg-mc-blue/15 text-mc-blue w-12 text-center">{p.proto}</span>
                      <span className="font-mono text-slate-300 w-28">{p.port}</span>
                      <span className="text-slate-500">{p.use}</span>
                      {p.inbound === false && <span className="text-[10px] text-slate-600 ml-auto">仅本机</span>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 官方链接 */}
            {links.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-slate-200 mb-2">官方文档</h3>
                <div className="flex flex-wrap gap-2">
                  {links.map(l => (
                    <button key={l.id || l.url} className="btn-ghost text-xs" onClick={() => openLink(l.url)}>↗ {l.name}</button>
                  ))}
                </div>
              </section>
            )}

            {guide?.notes?.length > 0 && (
              <div className="text-[11px] text-slate-600 space-y-1 border-t border-white/5 pt-3">
                {guide.notes.map((n, i) => <div key={i}>· {n}</div>)}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button className="btn-primary text-sm" onClick={async () => { await poll(); try { setGuide(await api.netGuide()) } catch {} }}>重新检测</button>
              <button className="btn-ghost text-sm" onClick={() => setGuideOpen(false)}>我知道了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
