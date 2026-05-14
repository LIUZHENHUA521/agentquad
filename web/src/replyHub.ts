import type { AiSession, AiStatus, AiTool, Quadrant, Todo } from './api'
import type { SessionMeta } from './store/aiSessionStore'

export interface UnreadSessionItem {
  id: string
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
}

export interface BuildUnreadSessionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  lastSeenMap: Map<string, number>
}

function uniqueTodoSessions(todo: Todo): AiSession[] {
  const byId = new Map<string, AiSession>()
  for (const session of [todo.aiSession, ...(todo.aiSessions || [])]) {
    if (!session?.sessionId) continue
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function buildUnreadSessionItems({ todos, liveSessions, lastSeenMap }: BuildUnreadSessionItemsInput): UnreadSessionItem[] {
  const tsBySid = new Map<string, number>()
  const metaBySid = new Map<string, { todoId: string; todoTitle: string; quadrant: Quadrant; tool: AiTool; label?: string }>()
  // 跟 deriveAiState 对齐：status === 'running' 优先于 unread，"会话在跑就别催待确认"。
  // liveSessions 比 todo snapshot 实时，所以后写入会覆盖 todo 给的旧 status。
  const statusBySid = new Map<string, AiStatus>()
  // 用户已经把 todo 标记为 'done' 的，名下所有 session 都不算"待确认"。后端 PUT /api/todos
  // 收到 status='done' 时会 pty.stop 它名下所有 live session，但 status 翻到 'stopped' 走
  // WS 有几百毫秒延迟；这里先按 todo.status 早过滤一拍，让顶栏 pill 在用户点完那一刻就降。
  const doneTodoIds = new Set<string>()

  for (const todo of todos) {
    if (todo.status === 'done') doneTodoIds.add(todo.id)
    for (const session of uniqueTodoSessions(todo)) {
      const ts = session.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(session.sessionId) || 0
        if (ts > prev) tsBySid.set(session.sessionId, ts)
      }
      if (session.status) statusBySid.set(session.sessionId, session.status)
      if (!metaBySid.has(session.sessionId)) {
        metaBySid.set(session.sessionId, {
          todoId: todo.id,
          todoTitle: todo.title || '(无标题)',
          quadrant: todo.quadrant,
          tool: session.tool,
          label: session.label,
        })
      }
    }
  }

  for (const live of liveSessions) {
    const ts = live.lastTurnDoneAt || 0
    if (ts > 0) {
      const prev = tsBySid.get(live.sessionId) || 0
      if (ts > prev) tsBySid.set(live.sessionId, ts)
    }
    if (live.status) statusBySid.set(live.sessionId, live.status)
    if (!metaBySid.has(live.sessionId)) {
      metaBySid.set(live.sessionId, {
        todoId: live.todoId,
        todoTitle: live.todoTitle || '(无标题)',
        quadrant: live.quadrant,
        tool: live.tool,
      })
    }
  }

  const items: UnreadSessionItem[] = []
  for (const [sid, ts] of tsBySid) {
    if (statusBySid.get(sid) === 'running') continue
    const meta = metaBySid.get(sid)
    if (!meta) continue
    if (doneTodoIds.has(meta.todoId)) continue
    const lastSeen = lastSeenMap.get(sid) || 0
    if (ts <= lastSeen) continue
    items.push({
      id: `unread:${sid}`,
      sessionId: sid,
      timestamp: ts,
      ...meta,
    })
  }

  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}
