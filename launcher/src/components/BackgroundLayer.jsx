import React, { useEffect, useRef } from 'react'

/**
 * 动态背景引擎（0.5.0 模块一）
 *  - dark      深色极简：token 底色 + 双径向光晕 + 极淡网格
 *  - particles Wallpaper Engine 风：Canvas 真实粒子漂移 + 近邻连线（尊重 prefers-reduced-motion）
 *  - image     本地图片：object-cover + 高斯模糊 + 半透明毛玻璃遮罩
 * 纯展示层，pointer-events:none，不拦截任何交互；配置由 appearance:validate 归一化。
 */
function hexRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return '91, 157, 255'
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

export default function BackgroundLayer({ config }) {
  const canvasRef = useRef(null)
  const c = config || {}
  const mode = c.mode || 'dark'
  const count = Math.max(12, Math.min(240, Number(c.particleCount) || 72))
  const speed = Math.max(0.1, Math.min(3, Number(c.particleSpeed) || 0.6))
  const color = c.particleColor || '#5b9dff'
  const blur = Math.max(0, Math.min(48, Number(c.blur) || 0))
  const overlay = Math.max(0.1, Math.min(0.9, Number(c.overlayOpacity) || 0.55))
  const imageDataUrl = c.imageDataUrl

  useEffect(() => {
    if (mode !== 'particles' || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const rgb = hexRgb(color)
    const reduced = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let particles = []
    let raf = 0

    const resize = () => {
      const w = canvas.clientWidth || 1
      const h = canvas.clientHeight || 1
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.7 * speed,
        vy: (Math.random() - 0.5) * 0.7 * speed,
        r: 0.7 + Math.random() * 1.9
      }))
      if (reduced) draw()
    }

    const draw = () => {
      const w = canvas.clientWidth || 1
      const h = canvas.clientHeight || 1
      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        if (!reduced) {
          p.x += p.vx; p.y += p.vy
          if (p.x < 0 || p.x > w) p.vx *= -1
          if (p.y < 0 || p.y > h) p.vy *= -1
        }
        // 近邻连线（O(n²)，n<=240，仅可见时运行）
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j]
          const dx = p.x - q.x, dy = p.y - q.y
          const d2 = dx * dx + dy * dy
          if (d2 < 130 * 130) {
            const a = (1 - Math.sqrt(d2) / 130) * 0.22
            ctx.strokeStyle = `rgba(${rgb}, ${a.toFixed(3)})`
            ctx.lineWidth = 0.6
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke()
          }
        }
        ctx.fillStyle = `rgba(${rgb}, 0.75)`
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill()
      }
      if (!reduced) raf = requestAnimationFrame(draw)
    }

    resize()
    if (!reduced) draw()
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize) }
  }, [mode, count, speed, color])

  return (
    <div className="bg-layer" aria-hidden="true">
      {(mode === 'dark' || mode === 'particles') && <div className="bg-dark" />}
      {mode === 'particles' && <canvas ref={canvasRef} className="bg-canvas" />}
      {mode === 'image' && imageDataUrl && (
        <>
          <div
            className="bg-image"
            style={{ backgroundImage: `url(${imageDataUrl})`, filter: `blur(${blur}px)` }}
          />
          <div className="bg-overlay" style={{ backgroundColor: `rgba(9, 12, 20, ${overlay})` }} />
        </>
      )}
      <div className="bg-vignette" />
    </div>
  )
}
