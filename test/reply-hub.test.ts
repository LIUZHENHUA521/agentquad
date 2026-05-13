import { describe, expect, it } from 'vitest'
import type { AiSession, Todo } from '../web/src/api.ts'
import {
  buildAttentionItems,
  buildUnreadSessionItems,
  countAttentionItems,
  parseSeenReplySessionIds,
  serializeSeenReplySessionIds,
} from '../web/src/replyHub.ts'
import type { SessionMeta } from '../web/src/store/aiSessionStore.ts'

function session(input: Partial<AiSession> & { sessionId: string }): AiSession {
  return {
    sessionId: input.sessionId,
    tool: input.tool || 'claude',
    nativeSessionId: input.nativeSessionId ?? null,
    cwd: input.cwd ?? null,
    status: input.status || 'done',
    startedAt: input.startedAt ?? 1000,
    completedAt: input.completedAt ?? 2000,
    prompt: input.prompt || 'prompt',
    label: input.label,
    lastTurnDoneAt: input.lastTurnDoneAt ?? null,
  }
}

function todo(input: Partial<Todo> & { id: string; title: string }): Todo {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description || '',
    quadrant: input.quadrant || 1,
    status: input.status || 'todo',
    dueDate: input.dueDate ?? null,
    workDir: input.workDir ?? null,
    brainstorm: input.brainstorm ?? false,
    appliedTemplateIds: input.appliedTemplateIds || [],
    sortOrder: input.sortOrder ?? 0,
    aiSession: input.aiSession ?? null,
    aiSessions: input.aiSessions || [],
    recurringRuleId: input.recurringRuleId ?? null,
    instanceDate: input.instanceDate ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
  }
}

function live(input: Partial<SessionMeta> & { sessionId: string; todoId: string }): SessionMeta {
  return {
    sessionId: input.sessionId,
    todoId: input.todoId,
    todoTitle: input.todoTitle || 'Live todo',
    quadrant: input.quadrant || 2,
    tool: input.tool || 'claude',
    status: input.status || 'running',
    autoMode: input.autoMode ?? null,
    nativeSessionId: input.nativeSessionId ?? null,
    cwd: input.cwd ?? null,
    startedAt: input.startedAt ?? 1000,
    completedAt: input.completedAt ?? null,
    lastOutputAt: input.lastOutputAt ?? null,
    outputBytesTotal: input.outputBytesTotal ?? 0,
    awaitingReply: input.awaitingReply ?? false,
    lastTurnDoneAt: input.lastTurnDoneAt ?? null,
  }
}

describe('buildAttentionItems', () => {
  it('creates a待交互 item for live pending_confirm sessions', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Fix login', quadrant: 1 })],
      liveSessions: [live({ sessionId: 's-live', todoId: 'todo-1', status: 'pending_confirm', lastOutputAt: 3000 })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'interaction:s-live',
      kind: 'interaction',
      sessionId: 's-live',
      todoId: 'todo-1',
      todoTitle: 'Fix login',
      quadrant: 1,
      tool: 'claude',
      timestamp: 3000,
    })
  })

  it('creates a待验收 item for ai_done todos with done sessions', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-2', title: 'Refactor terminal', status: 'ai_done', quadrant: 2, aiSessions: [session({ sessionId: 's-done', completedAt: 4000 })] })],
      liveSessions: [],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'review:s-done',
      kind: 'review',
      sessionId: 's-done',
      todoId: 'todo-2',
      todoTitle: 'Refactor terminal',
      quadrant: 2,
      timestamp: 4000,
    })
  })

  it('filters completed review items that have been marked seen', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-2', title: 'Refactor terminal', status: 'ai_done', aiSessions: [session({ sessionId: 's-done' })] })],
      liveSessions: [],
      seenSessionIds: new Set(['s-done']),
    })

    expect(items).toEqual([])
  })

  it('does not remove待交互 items when their session id is marked seen', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs input' })],
      liveSessions: [live({ sessionId: 's-pending', todoId: 'todo-1', status: 'pending_confirm' })],
      seenSessionIds: new Set(['s-pending']),
    })

    expect(items.map(item => item.kind)).toEqual(['interaction'])
  })

  it('prevents duplicate items when the same session appears as pending and in todo history', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs input', status: 'ai_done', aiSessions: [session({ sessionId: 's-same', status: 'done' })] })],
      liveSessions: [live({ sessionId: 's-same', todoId: 'todo-1', status: 'pending_confirm' })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('interaction')
  })

  it('sorts purely by newest timestamp regardless of kind', () => {
    const items = buildAttentionItems({
      todos: [
        todo({ id: 'todo-1', title: 'Old review', status: 'ai_done', aiSessions: [session({ sessionId: 's-old', completedAt: 1000 })] }),
        todo({ id: 'todo-2', title: 'New review', status: 'ai_done', aiSessions: [session({ sessionId: 's-new', completedAt: 5000 })] }),
      ],
      liveSessions: [live({ sessionId: 's-pending', todoId: 'todo-3', todoTitle: 'Pending', status: 'pending_confirm', lastOutputAt: 2000 })],
      seenSessionIds: new Set(),
    })

    // s-new (5000) > s-pending (2000) > s-old (1000)
    expect(items.map(item => item.sessionId)).toEqual(['s-new', 's-pending', 's-old'])
  })

  it('counts待交互, 待回复 and 待验收 separately', () => {
    const counts = countAttentionItems([
      { id: 'interaction:a', kind: 'interaction', sessionId: 'a', todoId: 'ta', todoTitle: 'A', quadrant: 1, tool: 'claude', timestamp: 1 },
      { id: 'awaiting:d', kind: 'awaiting_reply', sessionId: 'd', todoId: 'td', todoTitle: 'D', quadrant: 4, tool: 'claude', timestamp: 4 },
      { id: 'review:b', kind: 'review', sessionId: 'b', todoId: 'tb', todoTitle: 'B', quadrant: 2, tool: 'codex', timestamp: 2 },
      { id: 'review:c', kind: 'review', sessionId: 'c', todoId: 'tc', todoTitle: 'C', quadrant: 3, tool: 'cursor', timestamp: 3 },
    ])

    expect(counts).toEqual({ total: 4, interaction: 1, awaitingReply: 1, review: 2 })
  })

  it('creates a 待回复 item for live running sessions with awaitingReply=true', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-3', title: 'Continue chat', quadrant: 3 })],
      liveSessions: [live({ sessionId: 's-await', todoId: 'todo-3', status: 'running', awaitingReply: true, lastOutputAt: 5000 })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'awaiting:s-await',
      kind: 'awaiting_reply',
      sessionId: 's-await',
      todoId: 'todo-3',
      todoTitle: 'Continue chat',
      quadrant: 3,
      timestamp: 5000,
    })
  })

  it('does not create a 待回复 item when session is not running', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-3', title: 'Done already', status: 'ai_done', aiSessions: [session({ sessionId: 's-done', completedAt: 4000 })] })],
      liveSessions: [live({ sessionId: 's-done', todoId: 'todo-3', status: 'done', awaitingReply: true })],
      seenSessionIds: new Set(),
    })

    // session.status='done' → 不应该出现 awaiting；只应该出现 review (来自 todo.status='ai_done')
    expect(items.map(item => item.kind)).toEqual(['review'])
  })

  it('prefers待交互 over 待回复 when both flags are present on the same session', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Both signals' })],
      liveSessions: [live({ sessionId: 's1', todoId: 'todo-1', status: 'pending_confirm', awaitingReply: true })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('interaction')
  })

  it('sorts mixed kinds by newest timestamp first', () => {
    const items = buildAttentionItems({
      todos: [
        todo({ id: 'todo-r', title: 'Review', status: 'ai_done', aiSessions: [session({ sessionId: 's-rev', completedAt: 9000 })] }),
        todo({ id: 'todo-w', title: 'Waiting', quadrant: 1 }),
        todo({ id: 'todo-i', title: 'Interaction', quadrant: 1 }),
      ],
      liveSessions: [
        live({ sessionId: 's-await', todoId: 'todo-w', status: 'running', awaitingReply: true, lastOutputAt: 8000 }),
        live({ sessionId: 's-int', todoId: 'todo-i', status: 'pending_confirm', lastOutputAt: 1000 }),
      ],
      seenSessionIds: new Set(),
    })

    // 9000 (review) > 8000 (awaiting) > 1000 (interaction)
    expect(items.map(item => item.sessionId)).toEqual(['s-rev', 's-await', 's-int'])
  })
})

describe('buildUnreadSessionItems', () => {
  it('returns one item per session whose lastTurnDoneAt exceeds lastSeenAt', () => {
    const items = buildUnreadSessionItems({
      todos: [
        todo({
          id: 'todo-1',
          title: 'Inbox A',
          aiSessions: [session({ sessionId: 's-unread', lastTurnDoneAt: 5000 })],
        }),
      ],
      liveSessions: [],
      lastSeenMap: new Map([['s-unread', 4000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'unread:s-unread',
      sessionId: 's-unread',
      todoId: 'todo-1',
      todoTitle: 'Inbox A',
      timestamp: 5000,
    })
  })

  it('excludes sessions whose lastSeenAt has caught up with lastTurnDoneAt', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Seen', aiSessions: [session({ sessionId: 's1', lastTurnDoneAt: 3000 })] })],
      liveSessions: [],
      lastSeenMap: new Map([['s1', 3000]]),
    })

    expect(items).toEqual([])
  })

  it('takes the most recent lastTurnDoneAt across live and historical', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Hybrid', aiSessions: [session({ sessionId: 's1', lastTurnDoneAt: 2000 })] })],
      liveSessions: [live({ sessionId: 's1', todoId: 'todo-1', lastTurnDoneAt: 7000 })],
      lastSeenMap: new Map([['s1', 5000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0].timestamp).toBe(7000)
  })

  it('sorts newest unread first', () => {
    const items = buildUnreadSessionItems({
      todos: [
        todo({ id: 'todo-a', title: 'A', aiSessions: [session({ sessionId: 's-old', lastTurnDoneAt: 1000 })] }),
        todo({ id: 'todo-b', title: 'B', aiSessions: [session({ sessionId: 's-mid', lastTurnDoneAt: 5000 })] }),
        todo({ id: 'todo-c', title: 'C', aiSessions: [session({ sessionId: 's-new', lastTurnDoneAt: 9000 })] }),
      ],
      liveSessions: [],
      lastSeenMap: new Map(),
    })

    expect(items.map(i => i.sessionId)).toEqual(['s-new', 's-mid', 's-old'])
  })

  it('ignores sessions with no lastTurnDoneAt at all', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Quiet', aiSessions: [session({ sessionId: 's-quiet', lastTurnDoneAt: null })] })],
      liveSessions: [live({ sessionId: 's-quiet', todoId: 'todo-1' })],
      lastSeenMap: new Map(),
    })

    expect(items).toEqual([])
  })

  it('falls back to live meta when a session is not in todos', () => {
    const items = buildUnreadSessionItems({
      todos: [],
      liveSessions: [live({ sessionId: 's-orphan', todoId: 'todo-x', todoTitle: 'Orphan', quadrant: 2, lastTurnDoneAt: 6000 })],
      lastSeenMap: new Map(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sessionId: 's-orphan', todoId: 'todo-x', todoTitle: 'Orphan', quadrant: 2 })
  })

  it('includes live pending_confirm sessions even when lastTurnDoneAt is not newer than lastSeen', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs confirm' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        todoTitle: 'Needs confirm',
        status: 'pending_confirm',
        lastOutputAt: 3000,
        lastTurnDoneAt: null,
      })],
      lastSeenMap: new Map(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'unread:s-pc',
      sessionId: 's-pc',
      todoId: 'todo-1',
      reason: 'pending_confirm',
      timestamp: 3000,
    })
  })

  it('tags purely unread reply items with reason="unread"', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Has unread', aiSessions: [session({ sessionId: 's-u', lastTurnDoneAt: 7000 })] })],
      liveSessions: [],
      lastSeenMap: new Map([['s-u', 1000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0].reason).toBe('unread')
  })

  it('dedupes when a session is both pending_confirm and unread, preferring reason=pending_confirm', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Both', aiSessions: [session({ sessionId: 's-both', lastTurnDoneAt: 5000 })] })],
      liveSessions: [live({
        sessionId: 's-both',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastTurnDoneAt: 5000,
        lastOutputAt: 6000,
      })],
      lastSeenMap: new Map([['s-both', 1000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0].reason).toBe('pending_confirm')
    expect(items[0].timestamp).toBe(6000)
  })

  it('sorts mixed reasons by timestamp desc', () => {
    const items = buildUnreadSessionItems({
      todos: [
        todo({ id: 'todo-a', title: 'A', aiSessions: [session({ sessionId: 's-unread-old', lastTurnDoneAt: 2000 })] }),
        todo({ id: 'todo-b', title: 'B' }),
      ],
      liveSessions: [live({
        sessionId: 's-pc-new',
        todoId: 'todo-b',
        status: 'pending_confirm',
        lastOutputAt: 9000,
      })],
      lastSeenMap: new Map(),
    })

    expect(items.map(i => i.sessionId)).toEqual(['s-pc-new', 's-unread-old'])
  })
})

describe('seen reply storage helpers', () => {
  it('parses array storage values', () => {
    expect([...parseSeenReplySessionIds('["a","b",3,null]')]).toEqual(['a', 'b'])
  })

  it('parses object storage values for forward compatibility', () => {
    expect([...parseSeenReplySessionIds('{"a":171,"b":172}')]).toEqual(['a', 'b'])
  })

  it('returns an empty set for invalid storage', () => {
    expect(parseSeenReplySessionIds('not json')).toEqual(new Set())
  })

  it('serializes seen ids as a stable sorted array', () => {
    expect(serializeSeenReplySessionIds(new Set(['b', 'a']))).toBe('["a","b"]')
  })
})
