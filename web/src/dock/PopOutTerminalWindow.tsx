// web/src/dock/PopOutTerminalWindow.tsx
import React, { useCallback, useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import {
  CloseOutlined,
  PushpinOutlined,
  MinusOutlined,
  ExpandOutlined,
} from '@ant-design/icons'
import { useTerminalDockStore } from '../store/terminalDockStore'
import './popout.css'

interface Props {
  tabId: string
  initialX?: number
  initialY?: number
  children: React.ReactNode  // The TerminalDockTab rendered by parent — Portal moves this
}

export default function PopOutTerminalWindow({
  tabId,
  initialX,
  initialY,
  children,
}: Props) {
  const dock = useTerminalDockStore(s => s.dock)
  const close = useTerminalDockStore(s => s.close)
  const tab = useTerminalDockStore(s => s.openTabs.find(t => t.id === tabId))

  // Default position: top-right area of viewport
  const defaultX = initialX ?? Math.max(40, (typeof window !== 'undefined' ? window.innerWidth - 760 : 200))
  const defaultY = initialY ?? 80
  const [pos, setPos] = useState({ x: defaultX, y: defaultY })
  const [size, setSize] = useState({ w: 720, h: 480 })
  const [chip, setChip] = useState(false)

  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const dragMoveRef = useRef<((ev: MouseEvent) => void) | null>(null)
  const dragUpRef = useRef<(() => void) | null>(null)

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // Avoid starting drag from header buttons
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: pos.x, oy: pos.y }
    const onMove = (ev: MouseEvent) => {
      const r = dragRef.current
      if (!r) return
      setPos({
        x: r.ox + (ev.clientX - r.startX),
        y: Math.max(0, r.oy + (ev.clientY - r.startY)),
      })
    }
    const onUp = () => {
      dragRef.current = null
      if (dragMoveRef.current) document.removeEventListener('mousemove', dragMoveRef.current)
      if (dragUpRef.current) document.removeEventListener('mouseup', dragUpRef.current)
      dragMoveRef.current = null
      dragUpRef.current = null
    }
    dragMoveRef.current = onMove
    dragUpRef.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos])

  const resizeRef = useRef<{ startX: number; startY: number; ow: number; oh: number } | null>(null)
  const resizeMoveRef = useRef<((ev: MouseEvent) => void) | null>(null)
  const resizeUpRef = useRef<(() => void) | null>(null)

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, ow: size.w, oh: size.h }
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current
      if (!r) return
      setSize({
        w: Math.max(360, r.ow + (ev.clientX - r.startX)),
        h: Math.max(240, r.oh + (ev.clientY - r.startY)),
      })
    }
    const onUp = () => {
      resizeRef.current = null
      if (resizeMoveRef.current) document.removeEventListener('mousemove', resizeMoveRef.current)
      if (resizeUpRef.current) document.removeEventListener('mouseup', resizeUpRef.current)
      resizeMoveRef.current = null
      resizeUpRef.current = null
    }
    resizeMoveRef.current = onMove
    resizeUpRef.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [size])

  // Cleanup leftover listeners on unmount
  React.useEffect(() => {
    return () => {
      if (dragMoveRef.current) document.removeEventListener('mousemove', dragMoveRef.current)
      if (dragUpRef.current) document.removeEventListener('mouseup', dragUpRef.current)
      if (resizeMoveRef.current) document.removeEventListener('mousemove', resizeMoveRef.current)
      if (resizeUpRef.current) document.removeEventListener('mouseup', resizeUpRef.current)
    }
  }, [])

  if (!tab) return null

  if (chip) {
    // Keep children mounted (in a hidden div) so xterm + WS stay alive,
    // and overlay a small chip the user can click to restore the window.
    return (
      <>
        <div style={{ display: 'none' }}>{children}</div>
        <div
          className="popout-chip"
          onClick={() => setChip(false)}
          title={tab.todoTitle}
        >
          <span className={`terminal-dock__tab-dot status-${tab.status}`} />
          <span className="popout-chip__label">
            {tab.todoTitle.length > 18 ? tab.todoTitle.slice(0, 18) + '…' : tab.todoTitle}
          </span>
        </div>
      </>
    )
  }

  return (
    <div className="popout-window" style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}>
      <div className="popout-window__head" onMouseDown={onHeaderMouseDown}>
        <span className={`terminal-dock__tab-dot status-${tab.status}`} />
        <span className="popout-window__title">{tab.todoTitle}</span>
        <Tooltip title="收回 Dock">
          <Button type="text" size="small" icon={<PushpinOutlined />} onClick={() => dock(tabId)} />
        </Tooltip>
        <Tooltip title="缩成 chip">
          <Button type="text" size="small" icon={<MinusOutlined />} onClick={() => setChip(true)} />
        </Tooltip>
        <Tooltip title="关闭会话">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => close(tabId)} />
        </Tooltip>
      </div>
      <div className="popout-window__body">{children}</div>
      <div className="popout-window__resize" onMouseDown={onResizeMouseDown}>
        <ExpandOutlined />
      </div>
    </div>
  )
}
