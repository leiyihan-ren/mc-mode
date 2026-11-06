import React, { useEffect, useState, useCallback, useRef } from 'react'

/** 模块二：一键联机大厅（基于真实 EasyTier P2P VPN） */
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
  const timerRef = useRef(null)

  const refreshBinaries = useCallback(async () => {
    try { setBinaries(await window.mcnext.lanBinaries()) } catch (e) { setMsg({ type: 'error', text: `读取二进制失败: ${e.message}` }) }
  }, [])
  const refreshRooms = useCallback(async () => {
    try { setRooms(await window.mcnext.lanListRooms()) } catch { /* noop */ }
  }, [])
  useEffect(() => { refreshBinaries(); refreshRooms() }, [refreshBinaries, refreshRooms])

  const poll = useCallback(async () => {
    try {
      const s = await window.mcnext.lanStatus()
      setStatus(s)
      setRunning(!!s.running)
    } catch { /* noop */ }
  }, [])

  useEffect(() => {
    if (running) {
      poll()
      timerRef.current = setInterval(poll, 3000)
      return () => clearInterval(timerRef.current)
    }
    setStatus(null)
  }, [running, poll])

  const createRoom = async () => {
    setMsg(null)
    try {
      const { room, inviteCode } = await window.mcnext.lanCreate({ mcVersion })
      setRoom(room); setInviteCode(inviteCode); setMode('create')
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }
  const joinRoom = async () => {
    setMsg(null)
    try {
      const { room, inviteCode } = await window.mcnext.lanJoin(inviteCode)
      setRoom(room); setMode('join')
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }
  const start = async () => {
    setMsg(null)
    if (!room) return
    try {
      const r = await window.mcnext.lanStart(room, { noTun: true })
      if (r.ok) { setRunning(true); setMsg({ type: 'ok', text: `联机核心已启动（PID ${r.pid}）。虚拟 IP 需稍后由状态面板确认。` }) }
      else setMsg({ type: 'error', text: r.error })
    } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }
  const stop = async () => {
    try { await window.mcnext.lanStop(); setRunning(false); setStatus(null) } catch (e) { setMsg({ type: 'error', text: e.message }) }
  }

  const copy = () => navigator.clipboard?.writeText(inviteCode).then(() => setMsg({ type: 'ok', text: '邀请码已复制' }))

  return (
    <div className="h-full flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">一键联机大厅</h1>
        <p className="text-sm text-slate-500 mt-1">基于 EasyTier 真实 P2P 内网穿透，创建房间生成邀请码，好友输入即可加入局域网，无需端口映射</p>
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
                    <button className="btn-ghost text-xs shrink-0" onClick={copy}>复制</button>
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
          <div className="text-sm font-medium text-slate-300">组网状态</div>
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

              <div>
                <div className="text-xs text-slate-500 mb-1">已连接成员（来自 easytier-cli 真实输出）</div>
                {status.peers.length === 0
                  ? <div className="text-xs text-slate-600">暂无其他成员（已自动加入公共发现节点，等待好友用邀请码加入）</div>
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
    </div>
  )
}
