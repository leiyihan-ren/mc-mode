import React, { useEffect, useRef } from 'react'
import { SkinViewer as SkinViewer3D, WalkingAnimation } from 'skinview3d'

/**
 * 模块四：3D 皮肤渲染组件（skinview3d）。
 * 支持拖拽旋转、滚轮缩放（OrbitControls 默认开启）、自动旋转与行走动画。
 * 任何加载失败都降级为占位提示，绝不抛出白屏。
 */
export default function SkinViewer({ skinUrl, model = 'auto-detect', autoRotate = true, className = '' }) {
  const canvasRef = useRef(null)
  const viewerRef = useRef(null)
  const [error, setError] = React.useState(null)

  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const viewer = new SkinViewer3D({
        canvas: canvasRef.current,
        width: 240,
        height: 320,
        model: model
      })
      viewer.autoRotate = autoRotate
      viewer.animation = new WalkingAnimation()
      viewerRef.current = viewer
      setError(null)
    } catch (e) {
      setError(e.message || String(e))
      viewerRef.current = null
    }
    return () => {
      try { viewerRef.current && viewerRef.current.dispose && viewerRef.current.dispose() } catch { /* noop */ }
      viewerRef.current = null
    }
  }, []) // 仅初始化一次

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !skinUrl) return
    try {
      if (skinUrl instanceof Promise) {
        skinUrl.then(u => viewer.loadSkin(u, { model })).catch(() => {})
      } else {
        viewer.loadSkin(skinUrl, { model })
      }
    } catch { /* 加载失败时保持上一帧 */ }
  }, [skinUrl, model])

  if (error) {
    return (
      <div className={`flex items-center justify-center text-xs text-slate-500 ${className}`}>
        3D 预览不可用：{error}
      </div>
    )
  }
  return <canvas ref={canvasRef} className={className} />
}
