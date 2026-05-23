import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import { runLocalSessionTick } from '../src/local-session-tick.js'

const THIRTY_MIN_MS = 30 * 60 * 1000

describe('runLocalSessionTick', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('codex idle 且 lastStopAt > 30min → 翻 done + completedAt', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-1',
      aiSessions: [{
        sessionId: 's1', nativeSessionId: 'n1', tool: 'codex',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    const s = db.getTodo(todo.id).aiSessions[0]
    expect(s.status).toBe('done')
    expect(s.completedAt).toBe(now)
  })

  it('lastStopAt < 30min → 不动', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-2',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n2', tool: 'codex',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - 5 * 60 * 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
  })

  it('claude session 不受影响（claude 有 SessionEnd）', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'claude-1',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n3', tool: 'claude',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
  })

  it('source=web 的 codex 不受影响', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-web',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n4', tool: 'codex',
        status: 'idle', source: 'web',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
  })

  it('source=adopted + codex 也会超时', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-adopted',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n5', tool: 'codex',
        status: 'idle', source: 'adopted',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('done')
  })

  it('status=running 的 codex 不被强制翻 done（必须先 Stop）', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-running',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n6', tool: 'codex',
        status: 'running', source: 'local-capture',
        startedAt: now - 60 * 60 * 1000
        // no lastStopAt
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('running')
  })

  it('支持通过 timeoutMs 覆盖默认 30 分钟', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-custom-timeout',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n-custom', tool: 'codex',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - 6 * 60 * 1000  // 6 min ago
      }]
    })
    // 默认 30min 不会超时
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
    // 把 timeout 调到 5 分钟 → 触发
    runLocalSessionTick({ db, now, timeoutMs: 5 * 60 * 1000 })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('done')
  })
})
