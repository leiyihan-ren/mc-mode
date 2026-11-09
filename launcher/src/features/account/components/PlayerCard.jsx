import { api } from '@/services'
import React, { useEffect, useState } from 'react'

/**
 * 0.6.0 模块二：主页正版玩家卡片。
 * 数据来自 auth:current —— 微软 OAuth2 设备码全链路后由 Mojang /minecraft/profile 真实读取的
 * name / UUID / skinUrl。皮肤贴图用 Mojang 返回的 textures.minecraft.net URL 直接展示，
 * 加载失败降级为文字占位，不伪造头像。演示模式（mock）明确标注。
 */
export default function PlayerCard({ goto }) {
  const [data, setData] = useState({ loading: true, account: null, demo: false, error: null })
  const [imgOk, setImgOk] = useState(true)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        if (!api || typeof api.authCurrent !== 'function') {
          if (alive) setData({ loading: false, account: null, demo: false, error: '当前环境不支持账号查询' })
          return
        }
        const r = await api.authCurrent()
        if (!alive) return
        if (r && r.ok === false) {
          setData({ loading: false, account: null, demo: false, error: r.error })
        } else {
          setData({ loading: false, account: r.account || null, demo: !!r.demo, error: null })
          setImgOk(true)
        }
      } catch (e) {
        if (alive) setData({ loading: false, account: null, demo: false, error: e.message })
      }
    }
    load()
    const iv = setInterval(load, 15000)  // 账号中心登录后自动刷新
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const a = data.account
  const initial = a && a.name ? a.name[0].toUpperCase() : '?'

  return (
    <div className="glass-panel px-3 py-2 flex items-center gap-3 shrink-0 max-w-[260px]" title={data.error || (a ? `${a.name} · ${a.uuid}` : '')}>
      <button
        className="w-11 h-11 rounded-xl overflow-hidden border border-white/10 bg-base-900 flex items-center justify-center shrink-0"
        onClick={() => goto && a && goto('skin')}
        title={a ? '查看 3D 皮肤预览' : '前往账号中心登录'}
      >
        {a && a.skinUrl && imgOk ? (
          <img src={a.skinUrl} alt={a.name} onError={() => setImgOk(false)}
               className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
        ) : (
          <span className="text-lg font-bold text-slate-500">{initial}</span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-slate-500 uppercase tracking-wider">Player</span>
          {data.demo && <span className="tag bg-mc-gold/15 text-mc-gold text-[9px] px-1.5 py-0">演示</span>}
          {a && !data.demo && <span className="tag bg-accent/15 text-accent text-[9px] px-1.5 py-0">正版</span>}
        </div>
        <div className="text-sm font-medium text-slate-200 truncate">
          {data.loading ? '读取中…' : (a ? a.name : '离线模式')}
        </div>
        <div className="text-[10px] font-mono text-slate-600 truncate">
          {data.error ? data.error : (a ? a.uuid : '未登录微软账号')}
        </div>
      </div>
      {!a && goto && (
        <button className="btn-ghost text-[11px] px-2 py-1 shrink-0" onClick={() => goto('account')}>登录</button>
      )}
    </div>
  )
}
