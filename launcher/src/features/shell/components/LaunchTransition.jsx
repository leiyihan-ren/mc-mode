import React, { useEffect } from 'react'

/**
 * 启动过渡动画（0.5.0 模块一）
 * 点击「启动游戏」时：App shell 缩小淡出（见 index.css .app-shell-launching），
 * 本组件全屏承接「进入游戏」的过程 —— 旋转立方体 + 版本名 + 进度条 + 阶段提示。
 * 纯视觉，约 1.45s 后 onDone；真实启动请求与之并行（Promise.all），不阻塞 JVM。
 */
export default function LaunchTransition({ version, onDone }) {
  useEffect(() => {
    const t = setTimeout(() => onDone && onDone(), 1450)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="launch-fx" aria-hidden="true">
      <div className="launch-fx-inner">
        <div className="launch-cube">
          <span className="lc-face lc-f1" />
          <span className="lc-face lc-f2" />
          <span className="lc-face lc-f3" />
          <span className="lc-face lc-f4" />
        </div>
        <div className="launch-title">正在进入游戏</div>
        <div className="launch-sub font-mono">{version || 'Minecraft'}</div>
        <div className="launch-bar"><i /></div>
        <div className="launch-hint">加载资源 · 构建运行环境 · 启动 JVM</div>
      </div>
    </div>
  )
}
