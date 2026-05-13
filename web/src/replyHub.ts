import type { AiSession, AiTool, Quadrant, Todo } from './api'
import type { SessionMeta } from './store/aiSessionStore'

export const SEEN_REPLY_STORAGE_KEY = 'quadtodo:seenAiReplies'

export type AttentionKind = 'interaction' | 'awaiting_reply' | 'review'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
}

export interface AttentionCounts {
  total: number
  interaction: number
  awaitingReply: number
  review: number
}

export interface BuildAttentionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  seenSessionIds: Set<string>
}

export type UnreadReason = 'pending_confirm' | 'unread'

export interface UnreadSessionItem {
  id: string
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
  reason?: UnreadReason
}

export interface BuildUnreadSessionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  lastSeenMap: Map<string, number>
}

function normalizeTimestamp(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function uniqueTodoSessions(todo: Todo): AiSession[] {
  const byId = new Map<string, AiSession>()
  for (const session of [todo.aiSession, ...(todo.aiSessions || [])]) {
    if (!session?.sessionId) continue
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function buildAttentionItems({ todos, liveSessions, seenSessionIds }: BuildAttentionItemsInput): AttentionItem[] {
  const todoById = new Map(todos.map(todo => [todo.id, todo]))
  const items: AttentionItem[] = []
  const usedSessionIds = new Set<string>()

  for (const live of liveSessions) {
    if (live.status !== 'pending_confirm') continue
    const todo = todoById.get(live.todoId)
    const title = todo?.title || live.todoTitle || '(无标题)'
    items.push({
      id: `interaction:${live.sessionId}`,
      kind: 'interaction',
      sessionId: live.sessionId,
      todoId: live.todoId,
      todoTitle: title,
      quadrant: todo?.quadrant || live.quadrant,
      tool: live.tool,
      timestamp: normalizeTimestamp(live.lastOutputAt, live.completedAt, live.startedAt),
    })
    usedSessionIds.add(live.sessionId)
  }

  for (const live of liveSessions) {
    if (!live.awaitingReply) continue
    if (usedSessionIds.has(live.sessionId)) continue
    if (live.status !== 'running') continue
    const todo = todoById.get(live.todoId)
    const title = todo?.title || live.todoTitle || '(无标题)'
    items.push({
      id: `awaiting:${live.sessionId}`,
      kind: 'awaiting_reply',
      sessionId: live.sessionId,
      todoId: live.todoId,
      todoTitle: title,
      quadrant: todo?.quadrant || live.quadrant,
      tool: live.tool,
      timestamp: normalizeTimestamp(live.lastOutputAt, live.startedAt),
    })
    usedSessionIds.add(live.sessionId)
  }

  for (const todo of todos) {
    const todoIsAwaitingReview = todo.status === 'ai_done'
    const todoIsAwaitingInteraction = todo.status === 'ai_pending'

    for (const session of uniqueTodoSessions(todo)) {
      if (usedSessionIds.has(session.sessionId)) continue

      if (todoIsAwaitingInteraction && session.status === 'pending_confirm') {
        items.push({
          id: `interaction:${session.sessionId}`,
          kind: 'interaction',
          sessionId: session.sessionId,
          todoId: todo.id,
          todoTitle: todo.title || '(无标题)',
          quadrant: todo.quadrant,
          tool: session.tool,
          timestamp: normalizeTimestamp(session.completedAt, session.startedAt, todo.updatedAt),
          label: session.label,
        })
        usedSessionIds.add(session.sessionId)
        continue
      }

      if (!todoIsAwaitingReview) continue
      if (session.status !== 'done') continue
      if (seenSessionIds.has(session.sessionId)) continue

      items.push({
        id: `review:${session.sessionId}`,
        kind: 'review',
        sessionId: session.sessionId,
        todoId: todo.id,
        todoTitle: todo.title || '(无标题)',
        quadrant: todo.quadrant,
        tool: session.tool,
        timestamp: normalizeTimestamp(session.completedAt, session.startedAt, todo.updatedAt),
        label: session.label,
      })
      usedSessionIds.add(session.sessionId)
    }
  }

  return items.sort((a, b) => b.timestamp - a.timestamp)
}

export function countAttentionItems(items: AttentionItem[]): AttentionCounts {
  let interaction = 0
  let awaitingReply = 0
  let review = 0
  for (const item of items) {
    if (item.kind === 'interaction') interaction++
    else if (item.kind === 'awaiting_reply') awaitingReply++
    else review++
  }
  return { total: interaction + awaitingReply + review, interaction, awaitingReply, review }
}

export function buildUnreadSessionItems({ todos, liveSessions, lastSeenMap }: BuildUnreadSessionItemsInput): UnreadSessionItem[] {
  const tsBySid = new Map<string, number>()
  const metaBySid = new Map<string, { todoId: string; todoTitle: string; quadrant: Quadrant; tool: AiTool; label?: string }>()
  const pendingConfirmSids = new Set<string>()

  for (const todo of todos) {
    for (const session of uniqueTodoSessions(todo)) {
      const ts = session.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(session.sessionId) || 0
        if (ts > prev) tsBySid.set(session.sessionId, ts)
      }
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
    if (live.status === 'pending_confirm') {
      pendingConfirmSids.add(live.sessionId)
      // pending_confirm 即便没有 lastTurnDoneAt 也要纳入，timestamp 取各时间字段的最大值
      const liveTs = Math.max(
        live.lastTurnDoneAt || 0,
        live.lastOutputAt || 0,
        live.startedAt || 0,
      )
      const prev = tsBySid.get(live.sessionId) || 0
      if (liveTs > prev) tsBySid.set(live.sessionId, liveTs)
    } else {
      const ts = live.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(live.sessionId) || 0
        if (ts > prev) tsBySid.set(live.sessionId, ts)
      }
    }
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
    const isPendingConfirm = pendingConfirmSids.has(sid)
    if (!isPendingConfirm) {
      const lastSeen = lastSeenMap.get(sid) || 0
      if (ts <= lastSeen) continue
    }
    const meta = metaBySid.get(sid)
    if (!meta) continue
    items.push({
      id: `unread:${sid}`,
      sessionId: sid,
      timestamp: ts,
      reason: isPendingConfirm ? 'pending_confirm' : 'unread',
      ...meta,
    })
  }

  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}

export function parseSeenReplySessionIds(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))
    if (parsed && typeof parsed === 'object') return new Set(Object.keys(parsed).filter(Boolean))
    return new Set()
  } catch {
    return new Set()
  }
}

export function serializeSeenReplySessionIds(ids: Set<string>): string {
  return JSON.stringify([...ids].filter(Boolean).sort())
}
