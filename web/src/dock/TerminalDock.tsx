// web/src/dock/TerminalDock.tsx
import React, { useCallback, useRef } from 'react'
import { Button, Tooltip } from 'antd'
import { CloseOutlined, MenuFoldOutlined } from '@ant-design/icons'
import { useTerminalDockStore, DOCK_LIMITS } from '../store/terminalDockStore'
import './dock.css'

export default function TerminalDock() {
  const { widthPx, isCollapsed, openTabs, toggleCollapsed, setWidth } = useTerminalDockStore()
  const dragStartRef = useRef<{ x: number; w: number } | null>(null)

  const onMouseDownDivider = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, w: widthPx }
    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      // dragging the divider left -> width grows
      const next = start.w + (start.x - ev.clientX)
      setWidth(next)
    }
    const onUp = () => {
      dragStartRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [widthPx, setWidth])

  if (isCollapsed) {
    return (
      <div className="terminal-dock terminal-dock--collapsed">
        <Tooltip title="展开 AI 终端 Dock">
          <Button
            type="text"
            icon={<MenuFoldOutlined style={{ transform: 'scaleX(-1)' }} />}
            onClick={toggleCollapsed}
            className="terminal-dock__expand-btn"
          />
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      className="terminal-dock"
      style={{ width: widthPx, minWidth: DOCK_LIMITS.MIN_W, maxWidth: DOCK_LIMITS.MAX_W }}
    >
      <div className="terminal-dock__divider" onMouseDown={onMouseDownDivider} />
      <div className="terminal-dock__head">
        <span className="terminal-dock__title">AI 终端 Dock</span>
        <span className="terminal-dock__count">{openTabs.length} 个会话</span>
        <Tooltip title="折叠">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={toggleCollapsed} />
        </Tooltip>
      </div>
      <div className="terminal-dock__body">
        {openTabs.length === 0 ? (
          <div className="terminal-dock__empty">没有打开的会话</div>
        ) : (
          <div className="terminal-dock__placeholder">[会话渲染区]</div>
        )}
      </div>
    </div>
  )
}
