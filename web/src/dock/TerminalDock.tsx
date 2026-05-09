// web/src/dock/TerminalDock.tsx
import React, { useCallback, useEffect, useRef } from 'react'
import { Button, Dropdown, Tooltip, message } from 'antd'
import { CloseOutlined, MenuFoldOutlined, ColumnWidthOutlined, MergeCellsOutlined } from '@ant-design/icons'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ResumeSessionInput } from '../api'
import { useTerminalDockStore, DOCK_LIMITS, DockTab } from '../store/terminalDockStore'
import TerminalDockTab from './TerminalDockTab'
import './dock.css'

function SortableDockTab({ tab, isActive }: { tab: DockTab; isActive: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`terminal-dock__tab ${isActive ? 'is-active' : ''}`}
      onClick={() => useTerminalDockStore.getState().setActive(tab.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          useTerminalDockStore.getState().close(tab.id)
        }
      }}
      title={tab.todoTitle}
    >
      <span className={`terminal-dock__tab-dot status-${tab.status}`} />
      <span className="terminal-dock__tab-label">
        {tab.todoTitle.length > 14 ? tab.todoTitle.slice(0, 14) + '…' : tab.todoTitle}
      </span>
      <CloseOutlined
        className="terminal-dock__tab-close"
        onClick={(e) => {
          e.stopPropagation()
          useTerminalDockStore.getState().close(tab.id)
        }}
      />
    </div>
  )
}

interface Props {
  // Resolve per-tab context. TodoManage looks up its `todos` to provide cwd + resumeTarget.
  resolveTabContext?: (tab: DockTab) => { cwd: string | null; resumeTarget: ResumeSessionInput | null }
  onSessionRecovered?: (todoId: string, nextSessionId: string) => void
  onSessionSwitch?: (todoId: string, nextSessionId: string) => void
  onDone?: (todoId: string, sessionId: string, r: { status: string; exitCode?: number }) => void
  onFork?: (todoId: string, sessionId: string) => void
}

export default function TerminalDock({
  resolveTabContext, onSessionRecovered, onSessionSwitch, onDone, onFork,
}: Props = {}) {
  const { widthPx, isCollapsed, openTabs, activeTabId, splitSecondaryTabId, toggleCollapsed, setWidth } = useTerminalDockStore()
  const dragStartRef = useRef<{ x: number; w: number } | null>(null)
  const moveHandlerRef = useRef<((ev: MouseEvent) => void) | null>(null)
  const upHandlerRef = useRef<(() => void) | null>(null)

  const onMouseDownDivider = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, w: widthPx }

    const onMove = (ev: MouseEvent) => {
      const start = dragStartRef.current
      if (!start) return
      // dragging the divider left -> width grows
      setWidth(start.w + (start.x - ev.clientX))
    }
    const onUp = () => {
      dragStartRef.current = null
      if (moveHandlerRef.current) document.removeEventListener('mousemove', moveHandlerRef.current)
      if (upHandlerRef.current) document.removeEventListener('mouseup', upHandlerRef.current)
      moveHandlerRef.current = null
      upHandlerRef.current = null
    }
    moveHandlerRef.current = onMove
    upHandlerRef.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [widthPx, setWidth])

  useEffect(() => {
    // Clean up any leftover drag listeners on unmount
    return () => {
      if (moveHandlerRef.current) document.removeEventListener('mousemove', moveHandlerRef.current)
      if (upHandlerRef.current) document.removeEventListener('mouseup', upHandlerRef.current)
      dragStartRef.current = null
      moveHandlerRef.current = null
      upHandlerRef.current = null
    }
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = openTabs.map(t => t.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    useTerminalDockStore.getState().reorder(arrayMove(ids, oldIdx, newIdx))
  }

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
        {activeTabId && openTabs.length >= 2 && !splitSecondaryTabId && (
          <Dropdown
            menu={{
              items: openTabs
                .filter(t => t.id !== activeTabId)
                .map(t => ({ key: t.id, label: t.todoTitle.length > 18 ? t.todoTitle.slice(0, 18) + '…' : t.todoTitle })),
              onClick: ({ key }) => {
                const canSplit = widthPx >= 720 && window.innerWidth >= 1280
                if (!canSplit) {
                  message.warning('Dock 宽度需 ≥ 720 且窗口宽度 ≥ 1280 才能并排')
                  return
                }
                useTerminalDockStore.getState().splitWith(String(key))
              },
            }}
            trigger={['click']}
          >
            <Tooltip title="并排比对另一个会话">
              <Button type="text" size="small" icon={<ColumnWidthOutlined />} className="pc-only" />
            </Tooltip>
          </Dropdown>
        )}
        {splitSecondaryTabId && (
          <Tooltip title="退出并排">
            <Button
              type="text" size="small"
              icon={<MergeCellsOutlined />}
              onClick={() => useTerminalDockStore.getState().unsplit()}
              className="pc-only"
            />
          </Tooltip>
        )}
        <Tooltip title="折叠">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={toggleCollapsed} />
        </Tooltip>
      </div>
      {openTabs.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={openTabs.map(t => t.id)} strategy={horizontalListSortingStrategy}>
            <div className="terminal-dock__tabs">
              {openTabs.map(tab => (
                <SortableDockTab key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      <div className={`terminal-dock__body ${splitSecondaryTabId ? 'is-split' : ''}`}>
        {openTabs.length === 0 ? (
          <div className="terminal-dock__empty">没有打开的会话</div>
        ) : (
          openTabs.map(tab => {
            const ctx = resolveTabContext?.(tab) ?? { cwd: null, resumeTarget: null }
            const isPrimary = tab.id === activeTabId
            const isSecondary = tab.id === splitSecondaryTabId
            const isVisible = isPrimary || isSecondary
            return (
              <div
                key={tab.id}
                className={`terminal-dock__pane ${isSecondary ? 'is-secondary' : ''} ${isPrimary ? 'is-primary' : ''}`}
                style={{ display: isVisible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
              >
                <TerminalDockTab
                  tab={tab}
                  cwd={ctx.cwd}
                  resumeTarget={ctx.resumeTarget}
                  visible={isVisible}
                  onSessionRecovered={onSessionRecovered ? (next) => onSessionRecovered(tab.todoId, next) : undefined}
                  onSessionSwitch={onSessionSwitch ? (next) => onSessionSwitch(tab.todoId, next) : undefined}
                  onDone={onDone ? (r) => onDone(tab.todoId, tab.id, r) : undefined}
                  onFork={onFork ? () => onFork(tab.todoId, tab.id) : undefined}
                />
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
