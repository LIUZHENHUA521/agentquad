import type { AiStatus, AiSession, LiveSession, Todo } from '../../api'

/**
 * 状态看板的列定义。
 *
 * Session → column 派生规则（重要：跟现有 unread badge 系统对齐）：
 *   - status=running                      → in_progress
 *   - status=pending_confirm              → needs_input  （PTY 检测到权限弹窗）
 *   - status=idle + 未读                  → needs_input  （AI 回完一轮，用户还没看 transcript）
 *   - status=idle + 已读                  → idle         （PTY 仍存活但已被确认）
 *   - status=done / stopped / failed      → 离开板，进 TodoCard 的 History
 *
 * 未读判定：`session.lastTurnDoneAt > local lastSeenAt`，由 unreadStore 维护。
 * 这里通过 `isUnread(session)` 注入 sessionsByColumn，避免本模块依赖 zustand。
 */
export type StatusColumnId = 'backlog' | 'in_progress' | 'needs_input' | 'idle'

export interface StatusColumnConfig {
  id: StatusColumnId
  labelKey: string
  fallbackLabel: string
  accentVar: string
}

export const STATUS_COLUMNS: StatusColumnConfig[] = [
  { id: 'backlog',     labelKey: 'todo:column.backlog',    fallbackLabel: '待办',   accentVar: '--sb-idle' },
  { id: 'in_progress', labelKey: 'todo:column.inProgress', fallbackLabel: '运行中', accentVar: '--sb-running' },
  { id: 'needs_input', labelKey: 'todo:column.needsInput', fallbackLabel: '需确认', accentVar: '--sb-warn' },
  { id: 'idle',        labelKey: 'todo:column.idle',       fallbackLabel: '已空闲', accentVar: '--sb-calm' },
]

/** 单个 session 应当归属哪一列；返回 null = 终态，不在板上 */
export function deriveColumnFor(s: AiSession, unread: boolean): StatusColumnId | null {
  switch (s.status) {
    case 'running':           return 'in_progress'
    case 'pending_confirm':   return 'needs_input'
    case 'idle':              return unread ? 'needs_input' : 'idle'
    case 'done':
    case 'stopped':
    case 'failed':            return null
    default:                  return null
  }
}

export function backlogTodos(todos: Todo[], showDone: boolean): Todo[] {
  return todos.filter((t) => {
    if (t.parentId) return false                          // 子待办平铺：parent_id 旧数据当成顶层
    if (t.status === 'missed') return false
    if (!showDone && t.status === 'done') return false
    return true
  })
}

export interface SessionEntry {
  session: AiSession
  todo: Todo
}

/** 把每个 todo 的所有 active sessions 拍平 + 反查 parent todo —— 方便右 3 列直接渲染 */
export function flattenSessions(todos: Todo[]): SessionEntry[] {
  const out: SessionEntry[] = []
  for (const t of todos) {
    if (!Array.isArray(t.aiSessions) || t.aiSessions.length === 0) {
      if (t.aiSession) out.push({ session: t.aiSession, todo: t })
      continue
    }
    for (const s of t.aiSessions) {
      out.push({ session: s, todo: t })
    }
  }
  return out
}

/**
 * 把所有 sessions 拍到 4 列里。
 * @param entries 拍平后的 (session, parent todo) 列表
 * @param isUnread 注入的未读判定（依赖外部 unreadStore）；不传则视为全部已读
 * @param liveSessions 当前 WebSocket / 3s-poll 维护的 live session map（aiSessionStore）。
 *                     如果某条 entry 在 live map 里能找到，用 live 的 status / effectiveStatus /
 *                     lastTurnDoneAt 覆盖 snapshot —— 这是状态变化时看板不用刷新页面就能
 *                     重新分桶的关键。
 */
export function sessionsByColumn(
  entries: SessionEntry[],
  isUnread: (s: AiSession) => boolean = () => false,
  liveSessions?: Map<string, LiveSession>,
): Record<StatusColumnId, SessionEntry[]> {
  const out: Record<StatusColumnId, SessionEntry[]> = {
    backlog: [],
    in_progress: [],
    needs_input: [],
    idle: [],
  }
  for (const entry of entries) {
    const effective = mergeLiveSession(entry.session, liveSessions?.get(entry.session.sessionId))
    const col = deriveColumnFor(effective, isUnread(effective))
    if (col === null) continue                  // 终态：不入板
    out[col].push({ session: effective, todo: entry.todo })
  }
  // 同一列按 startedAt desc（最新在上）
  for (const k of Object.keys(out) as StatusColumnId[]) {
    out[k].sort((a, b) => (b.session.startedAt || 0) - (a.session.startedAt || 0))
  }
  return out
}

/** snapshot session + 可选 live session → 合并版（优先 live.effectiveStatus，其次 live.status，再退 snapshot）。 */
export function mergeLiveSession(snapshot: AiSession, live?: LiveSession): AiSession {
  if (!live) return snapshot
  const status = live.effectiveStatus || live.status || snapshot.status
  return {
    ...snapshot,
    status,
    lastTurnDoneAt: live.lastTurnDoneAt ?? snapshot.lastTurnDoneAt ?? null,
    completedAt: live.completedAt ?? snapshot.completedAt,
  }
}

export function activeSessionCount(t: Todo): { active: number; total: number } {
  const all = Array.isArray(t.aiSessions) ? t.aiSessions : (t.aiSession ? [t.aiSession] : [])
  const active = all.filter((s) =>
    s.status === 'running' || s.status === 'pending_confirm' || s.status === 'idle',
  ).length
  return { active, total: all.length }
}

const TERMINAL_STATUSES: AiStatus[] = ['done', 'failed', 'stopped']
export function isTerminalSession(s: AiSession): boolean {
  return TERMINAL_STATUSES.includes(s.status)
}
