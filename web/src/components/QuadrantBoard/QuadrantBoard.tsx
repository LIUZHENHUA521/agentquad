import React, { useState, useRef, type CSSProperties, type ReactNode } from 'react'
import './QuadrantBoard.css'

export interface QuadrantBoardProps {
  topLeft: ReactNode
  topRight: ReactNode
  bottomLeft: ReactNode
  bottomRight: ReactNode
}

/**
 * QuadrantBoard 负责四象限 2x2 网格 + 3 条可拖拽分隔线（1 横 + 2 竖）的布局，
 * 内部维护 splitV / splitH 状态。父组件只需要提供 4 个象限的 JSX 节点。
 *
 * 注意：DndContext / DragOverlay 等跨象限协调逻辑保留在父组件，QuadrantBoard
 * 只负责"把 4 个区块按当前比例摆好"。
 */
export function QuadrantBoard({ topLeft, topRight, bottomLeft, bottomRight }: QuadrantBoardProps) {
  // 上下分割：上面占比；左右分割：左边占比（百分比）
  const [splitH, setSplitH] = useState(50)
  const [splitV, setSplitV] = useState(50)
  const boardRef = useRef<HTMLDivElement>(null)

  const startResizeV = (e: React.MouseEvent) => {
    e.preventDefault()
    const board = boardRef.current
    if (!board) return
    const startX = e.clientX
    const startSplit = splitV
    const boardW = board.getBoundingClientRect().width
    const onMove = (ev: MouseEvent) => {
      const delta = ((ev.clientX - startX) / boardW) * 100
      setSplitV(Math.max(20, Math.min(80, startSplit + delta)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const startResizeH = (e: React.MouseEvent) => {
    e.preventDefault()
    const board = boardRef.current
    if (!board) return
    const startY = e.clientY
    const startSplit = splitH
    const boardH = board.getBoundingClientRect().height
    const onMove = (ev: MouseEvent) => {
      const delta = ((ev.clientY - startY) / boardH) * 100
      setSplitH(Math.max(20, Math.min(80, startSplit + delta)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // 用 flex wrapper 给每个象限分配宽度；象限自身的 .todo-quadrant flex:1 会填满 wrapper。
  const cellStyle = (flex: number): CSSProperties => ({
    flex,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
  })

  return (
    <div className="todo-board" ref={boardRef}>
      {/* 上面一行：Q1 | 分隔线 | Q2 */}
      <div className="todo-board-row" style={{ flex: splitH }}>
        <div style={cellStyle(splitV)}>{topLeft}</div>
        <div className="todo-divider-v" onMouseDown={startResizeV} />
        <div style={cellStyle(100 - splitV)}>{topRight}</div>
      </div>

      {/* 水平分隔线 */}
      <div className="todo-divider-h" onMouseDown={startResizeH} />

      {/* 下面一行：Q3 | 分隔线 | Q4 */}
      <div className="todo-board-row" style={{ flex: 100 - splitH }}>
        <div style={cellStyle(splitV)}>{bottomLeft}</div>
        <div className="todo-divider-v" onMouseDown={startResizeV} />
        <div style={cellStyle(100 - splitV)}>{bottomRight}</div>
      </div>
    </div>
  )
}
