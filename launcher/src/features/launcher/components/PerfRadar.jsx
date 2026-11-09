import { api, appendBounded, BUFFER_LIMITS } from '@/services'
import React, { useEffect, useState } from 'react'

/**
 * 0.6.0 模块三：性能小雷达。
 * 数据 100% 来自主进程 JvmMonitor：JVM stdout/stderr 的 GC 日志 + /proc/<pid>/status 的 VmRSS。
 * 无数据/非 Linux 明确显示「不可用」，绝不画一条编造的曲线。
 */
// 0.9.0 模块二C：采样上限统一来自 BUFFER_LIMITS 单一数据源
const MAX_POINTS = BUFFER_LIMITS.METRIC_POINTS
const W = 600
const H = 110

function linePath(samples, key, maxV) {
  if (!samples.length) return ''
  return samples.map((s, i) => {
    const x = (i / Math.max(1, samples.length - 1)) * W
    const v = Number(s[key]) || 0
    const y = H - Math.min(1, v / maxV) * H
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
}

export default function PerfRadar() {
  const [state, setState] = useState({
    samples: [], running: false, platform: null,
    gc: { count: 0, totalPauseMs: 0, maxPauseMs: 0, last: null }
  })

  useEffect(() => {
    if (!api || typeof api.onJvmMetrics !== 'function') return
    let alive = true
    if (typeof api.jvmMonitorStatus === 'function') {
      api.jvmMonitorStatus().then(r => {
        if (!alive || !r) return
        setState(p => ({
          ...p,
          samples: Array.isArray(r.samples) ? appendBounded([], r.samples, MAX_POINTS) : [],
          gc: r.gc || p.gc,
          running: !!r.running,
          platform: r.platform || null
        }))
      }).catch(() => {})
    }
    const off = api.onJvmMetrics((m) => {
      setState(p => ({
        ...p,
        samples: appendBounded(p.samples, m, MAX_POINTS),
        running: !!m.running,
        gc: {
          ...p.gc,
          count: m.gcCount || 0,
          maxPauseMs: Math.max(p.gc.maxPauseMs || 0, m.gcPauseMs || 0),
          last: m.gcPauseMs != null ? { pauseMs: m.gcPauseMs } : p.gc.last
        }
      }))
    })
    return () => { alive = false; try { off && off() } catch { /* noop */ } }
  }, [])

  const samples = state.samples
  const last = samples[samples.length - 1] || null
  const values = samples.flatMap(s => [Number(s.rssMb) || 0, Number(s.heapAfterMb) || 0])
  const maxV = Math.max(256, ...values) * 1.1
  const rssAvailable = last && last.rssMb != null
  const hasSeries = samples.some(s => s.rssMb != null || s.heapAfterMb != null)

  return (
    <div className="glass-panel px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-300">📡 性能小雷达</span>
          <span className={`w-1.5 h-1.5 rounded-full ${state.running ? 'bg-mc-green animate-pulse' : 'bg-slate-600'}`} />
          <span className="text-[10px] text-slate-600">{state.running ? 'JVM 运行中' : '未运行'} · 每 1s 采样</span>
        </div>
        <div className="flex items-center gap-4 text-[11px]">
          <span className="text-slate-500">RSS <b className="text-accent font-mono">{rssAvailable ? `${last.rssMb} MB` : '不可用'}</b></span>
          <span className="text-slate-500">堆 <b className="text-mc-gold font-mono">{last && last.heapAfterMb != null ? `${last.heapAfterMb} MB` : '等待 GC 日志'}</b></span>
          <span className="text-slate-500">GC <b className="text-slate-300 font-mono">{state.gc.count}</b> 次</span>
          <span className="text-slate-500">最长暂停 <b className="text-slate-300 font-mono">{state.gc.maxPauseMs.toFixed(1)} ms</b></span>
        </div>
      </div>

      {hasSeries ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-24" role="img" aria-label="JVM 内存波动折线图">
          {[0.25, 0.5, 0.75].map(f => (
            <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
          ))}
          <path d={linePath(samples, 'rssMb', maxV)} fill="none" stroke="#5eead4" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <path d={linePath(samples, 'heapAfterMb', maxV)} fill="none" stroke="#f0b429" strokeWidth="1.5"
                strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <div className="h-24 flex items-center justify-center text-[11px] text-slate-600 border border-dashed border-white/5 rounded-lg">
          启动游戏后，这里会显示真实的 RSS 与 GC 堆占用曲线（不绘制模拟数据）
        </div>
      )}

      <div className="flex items-center gap-4 mt-1.5 text-[10px] text-slate-600">
        <span><i className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: '#5eead4' }} />进程 RSS（真实 /proc VmRSS）</span>
        <span><i className="inline-block w-3 h-0.5 align-middle mr-1" style={{ background: '#f0b429' }} />GC 后堆占用（真实 GC 日志）</span>
        <span>样本 {samples.length}/{MAX_POINTS}</span>
        {state.platform && state.platform !== 'linux' && (
          <span className="text-mc-gold">当前平台 {state.platform} 不提供 /proc，RSS 采样明确显示为不可用</span>
        )}
      </div>
    </div>
  )
}
