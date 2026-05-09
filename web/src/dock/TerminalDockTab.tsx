// web/src/dock/TerminalDockTab.tsx
import React from 'react'
import SessionViewer from '../SessionViewer'
import { TodoStatus, ResumeSessionInput } from '../api'
import { useTerminalDockStore, DockTab, DockTabStatus } from '../store/terminalDockStore'

function todoStatusToDockStatus(s: TodoStatus): DockTabStatus {
  switch (s) {
    case 'ai_running':  return 'running'
    case 'ai_pending':  return 'pending_reply'
    case 'ai_done':     return 'idle'
    case 'done':        return 'idle'
    case 'todo':        return 'idle'
    case 'missed':      return 'closed'
    default:            return 'idle'
  }
}

interface Props {
  tab: DockTab
  cwd?: string | null
  resumeTarget?: ResumeSessionInput | null
  visible: boolean   // false -> display:none so xterm instance is preserved
  onSessionRecovered?: (next: string) => void
  onSessionSwitch?: (next: string) => void
  onDone?: (r: { status: string; exitCode?: number }) => void
  onFork?: () => void
}

export default function TerminalDockTab({
  tab, cwd, resumeTarget, visible,
  onSessionRecovered, onSessionSwitch, onDone, onFork,
}: Props) {
  const close = useTerminalDockStore(s => s.close)
  const setStatus = useTerminalDockStore(s => s.setStatus)

  // DockTabStatus -> TodoStatus mapping (Task 9 will wire bidirectional updates via onStatusChange)
  let todoStatus: TodoStatus
  switch (tab.status) {
    case 'pending_reply':
      todoStatus = 'ai_pending'
      break
    case 'running':
      todoStatus = 'ai_running'
      break
    case 'idle':
    case 'closed':
    default:
      todoStatus = 'ai_done'
      break
  }

  return (
    <div
      className="terminal-dock-tab"
      style={{ display: visible ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      {/* TODO: When AiTerminalMini reports onSessionRecovered with a new sessionId,
          dock store's tab.id (= old sessionId) becomes stale, leading to duplicate
          tabs if user re-opens the recovered session. Future task: add
          dock.renameTab(oldId, newId) action and call here. */}
      <SessionViewer
        sessionId={tab.id}
        todoId={tab.todoId}
        status={todoStatus}
        cwd={cwd ?? null}
        resumeTarget={resumeTarget ?? null}
        onSessionRecovered={onSessionRecovered}
        onSessionSwitch={onSessionSwitch}
        onClose={() => close(tab.id)}
        onDone={(r) => {
          setStatus(tab.id, r.exitCode === 0 ? 'idle' : 'closed')
          onDone?.(r)
        }}
        onStatusChange={(s) => setStatus(tab.id, todoStatusToDockStatus(s))}
        onFork={onFork ? () => onFork() : undefined}
        fillHeight
      />
    </div>
  )
}
