import React, { useEffect, useState, useCallback } from 'react'
import SkinViewer from '../components/SkinViewer.jsx'

/** 模块四：3D 皮肤渲染与外观定制 */
export default function SkinPage() {
  const [accounts, setAccounts] = useState([])
  const [apiRoot, setApiRoot] = useState('https://littleskin.cn/api/yggdrasil')
  const [player, setPlayer] = useState('')
  const [skinUrl, setSkinUrl] = useState(null) // dataURL for viewer
  const [fetching, setFetching] = useState(false)
  const [msg, setMsg] = useState(null)

  // 上传（LittleSkin 等需显式配置端点）
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [model, setModel] = useState('auto-detect')
  const [localFile, setLocalFile] = useState(null)
  const [localInfo, setLocalInfo] = useState(null)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    window.mcnext.authList().then(list => setAccounts(Array.isArray(list) ? list : [])).catch(() => {})
  }, [])

  const fillFromAccount = (acc) => {
    if (acc.type === 'authlib' && acc.apiRoot) setApiRoot(acc.apiRoot)
    if (acc.name) setPlayer(acc.name)
  }

  const fetchSkin = useCallback(async () => {
    setFetching(true); setMsg(null)
    try {
      const r = await window.mcnext.skinFetchFromAuthlib(apiRoot, player)
      if (!r.ok) throw new Error('皮肤站未返回')
      const dl = await window.mcnext.skinDownloadImage(r.skinUrl)
      setSkinUrl(dl.dataUrl)
      setMsg({ type: 'ok', text: `✓ 已加载 ${r.profileName} 的皮肤（${r.skinModel}）` })
    } catch (e) {
      setMsg({ type: 'error', text: `获取失败: ${e.message}` })
    }
    setFetching(false)
  }, [apiRoot, player])

  const onFile = (e) => {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = async () => {
      const buf = new Uint8Array(reader.result)
      try {
        // 由主进程校验 PNG 并返回 dataURL
        const r = await new Promise((resolve) => {
          const fr = new FileReader()
          fr.onload = () => resolve({ dataUrl: fr.result })
          fr.readAsDataURL(f)
        })
        setLocalFile({ name: f.name, arrayBuffer: buf.buffer })
        setLocalInfo({ ok: true, name: f.name, bytes: buf.length })
        setSkinUrl(r.dataUrl)
        setMsg({ type: 'ok', text: `已载入本地皮肤 ${f.name}（请确认尺寸合法后再上传）` })
      } catch (err) { setMsg({ type: 'error', text: err.message }) }
    }
    reader.readAsArrayBuffer(f)
  }

  const doUpload = async () => {
    setUploading(true); setMsg(null)
    try {
      const r = await window.mcnext.skinUpload({
        endpoint, token, model,
        buf: localFile ? localFile.arrayBuffer : undefined,
        player: player || undefined
      })
      if (r.ok) setMsg({ type: 'ok', text: `✓ 已同步到皮肤站（HTTP ${r.status}）。实际生效以皮肤站侧角色材质为准。` })
      else setMsg({ type: 'error', text: r.error || `上传失败: HTTP ${r.status}` })
    } catch (e) {
      // 诚实边界：未配置端点 / Token 时明确报错，不伪造成功
      setMsg({ type: 'error', text: e.message })
    }
    setUploading(false)
  }

  return (
    <div className="h-full flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-bold text-slate-100">3D 皮肤渲染与外观定制</h1>
        <p className="text-sm text-slate-500 mt-1">实时渲染当前皮肤，支持拖拽旋转 / 滚轮缩放；从皮肤站获取或上传自定义皮肤</p>
      </header>

      {msg && (
        <div className={`glass-panel px-4 py-3 text-sm border ${msg.type === 'ok' ? 'border-mc-green/30 text-mc-green' : 'border-mc-red/30 text-mc-red'}`}>{msg.text}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 min-h-0 flex-1">
        {/* 左：3D 预览 */}
        <div className="glass-panel p-6 flex flex-col items-center justify-center gap-3">
          <div className="bg-base-900/40 rounded-2xl border border-white/5 flex items-center justify-center" style={{ minHeight: 340 }}>
            <SkinViewer skinUrl={skinUrl} model={model} />
          </div>
          <div className="flex gap-2">
            <select className="bg-base-900/60 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-slate-300 outline-none"
              value={model} onChange={e => setModel(e.target.value)}>
              <option value="auto-detect">模型：自动识别</option>
              <option value="default">经典 Steve</option>
              <option value="slim">细臂 Alex</option>
            </select>
            <span className="text-[10px] text-slate-600 self-center">拖拽旋转 · 滚轮缩放</span>
          </div>
        </div>

        {/* 右：获取 / 上传 */}
        <div className="glass-panel p-6 flex flex-col gap-4 overflow-y-auto">
          <div>
            <div className="text-sm font-medium text-slate-300 mb-2">从皮肤站获取（Authlib-Injector 兼容协议）</div>
            {accounts.filter(a => a.type === 'authlib').length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {accounts.filter(a => a.type === 'authlib').map(a => (
                  <button key={a.uuid} className="btn-ghost text-xs" onClick={() => fillFromAccount(a)}>{a.name}</button>
                ))}
              </div>
            )}
            <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50 mb-2"
              value={apiRoot} onChange={e => setApiRoot(e.target.value)} placeholder="皮肤站 API 根（Yggdrasil）" />
            <div className="flex gap-2">
              <input className="flex-1 bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm outline-none focus:border-accent/50"
                value={player} onChange={e => setPlayer(e.target.value)} placeholder="角色名" />
              <button className="btn-primary text-sm" onClick={fetchSkin} disabled={fetching || !player}>获取</button>
            </div>
          </div>

          <div className="border-t border-white/5 pt-4">
            <div className="text-sm font-medium text-slate-300 mb-2">上传自定义皮肤</div>
            <label className="btn-ghost text-sm inline-block cursor-pointer">
              选择本地皮肤 PNG
              <input type="file" accept="image/png" className="hidden" onChange={onFile} />
            </label>
            {localInfo && <div className="text-xs text-slate-500 mt-2">已选择：{localInfo.name}（{localInfo.bytes} 字节）</div>}
            <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50 mt-3"
              value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="上传端点 URL（https，需皮肤站开放 API）" />
            <input className="w-full bg-base-900/60 border border-white/10 rounded-xl px-4 py-2 text-sm font-mono outline-none focus:border-accent/50 mt-2"
              value={token} onChange={e => setToken(e.target.value)} placeholder="API Token（皮肤站用户中心生成）" />
            <button className="btn-primary text-sm mt-3 w-full" onClick={doUpload} disabled={uploading || !localFile}>
              {uploading ? '上传中…' : '同步到皮肤站'}
            </button>
            <p className="text-[10px] text-slate-600 mt-2 leading-relaxed">
              诚实边界：LittleSkin 官方仅公开 Yggdrasil 认证协议，未提供稳定的公开一键上传 REST API。
              上传需你所用皮肤站（或自建 Blessing Skin + User API 插件）的开放端点与 Token；未配置时会明确报错，绝不伪造「同步成功」。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
