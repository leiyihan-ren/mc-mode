/**
 * InstanceContext.jsx — 0.9.0 模块一A：当前激活实例 + 一键平滑切换
 *
 * 设计：
 *  - 单一数据源：后端 isolation.ACTIVE_FILE（真实持久化），前端 Context 只做回显与过渡态。
 *  - 平滑过渡：切换时先进入 switching 态（内容淡出/轻微模糊），等后端切换完成 +
 *    一个 CSS 过渡周期后再恢复，绝不出现「列表瞬间跳变」的割裂感。
 *  - 事件驱动：onInstanceChanged 让多页面（首页 / 实例页）同步回显，删除当前实例也会广播。
 *  - 底层不可用时（纯浏览器预览）降级为明确的 null，不伪造激活实例。
 */
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import { api } from '@/services'

const InstanceContext = createContext(null)

/** 过渡时长需与 index.css 里 .instance-switching 的 transition 对齐 */
export const SWITCH_TRANSITION_MS = 260

export function InstanceProvider({ children }) {
  const [activeId, setActiveId] = useState(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState(null)
  const [version, setVersion] = useState(0) // 递增触发页面重读实例数据
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    // 初次读取后端真实激活实例
    if (api.isAvailable() && typeof api.instanceActive === 'function') {
      api.instanceActive().then((id) => { if (mounted.current) setActiveId(id || null) }).catch(() => {})
    }
    // 多页面/删除实例时的广播同步
    let off = () => {}
    if (api.isAvailable() && typeof api.onInstanceChanged === 'function') {
      off = api.onInstanceChanged((p) => {
        if (!mounted.current) return
        setActiveId(p && p.activeId ? p.activeId : null)
        setVersion(v => v + 1)
      }) || (() => {})
    }
    return () => { mounted.current = false; if (typeof off === 'function') off() }
  }, [])

  /** 一键切换：过渡态 → 后端原子切换 → 广播 → 过渡结束复位 */
  const switchTo = useCallback(async (id) => {
    if (!id) return { ok: false, error: '实例 id 为空' }
    if (!api.isAvailable() || typeof api.instanceSwitch !== 'function') {
      return { ok: false, error: '当前环境不支持实例切换（非桌面/安卓运行环境）' }
    }
    setSwitching(true)
    setError(null)
    try {
      const r = await api.instanceSwitch(id)
      if (!r || !r.ok) {
        setError(r?.error || '切换失败')
        return r || { ok: false }
      }
      setActiveId(r.to)
      setVersion(v => v + 1)
      // 等待 CSS 过渡完成再解除 switching，保证视觉连续
      await new Promise(res => setTimeout(res, SWITCH_TRANSITION_MS))
      return r
    } catch (e) {
      setError(e.message)
      return { ok: false, error: e.message }
    } finally {
      if (mounted.current) setSwitching(false)
    }
  }, [])

  const clearActive = useCallback(async () => {
    // 无显式 unset IPC，通过切换到不存在实例被拒后仍保留；这里仅做前端态清理（供 UI 取消高亮）
    setActiveId(null)
    setVersion(v => v + 1)
  }, [])

  const value = { activeId, switching, error, version, switchTo, clearActive }
  return <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>
}

export function useInstance() {
  const ctx = useContext(InstanceContext)
  return ctx || { activeId: null, switching: false, error: null, version: 0, switchTo: async () => ({ ok: false }), clearActive: () => {} }
}

export default InstanceContext
