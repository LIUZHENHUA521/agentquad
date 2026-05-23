import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'

describe('findTodoByNativeSessionId', () => {
  let db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('能查到 aiSessions 中含指定 nativeSessionId 的 todo', () => {
    const todo = db.createTodo({
      title: 'host',
      aiSessions: [{
        sessionId: 'sess-1',
        nativeSessionId: 'native-abc',
        tool: 'claude',
        status: 'running',
        startedAt: Date.now()
      }]
    })
    const found = db.findTodoByNativeSessionId('native-abc')
    expect(found?.id).toBe(todo.id)
  })

  it('不存在时返回 null', () => {
    expect(db.findTodoByNativeSessionId('nope')).toBeNull()
  })

  it('archived todo 不被返回', () => {
    const todo = db.createTodo({
      title: 'archived',
      aiSessions: [{ sessionId: 's', nativeSessionId: 'native-x', tool: 'claude', status: 'running' }]
    })
    db.archiveTodo(todo.id)
    expect(db.findTodoByNativeSessionId('native-x')).toBeNull()
  })
})

describe('createLocalCaptureTodo', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  const baseInput = {
    tool: 'claude',
    nativeSessionId: 'native-1',
    cwd: '/Users/me/projects/crazyCombo',
    initialPrompt: null,
    defaults: {
      defaultTelegramRoute: { chatId: 999 },
      defaultLarkRoute: null
    }
  }

  it('Phase 1 标题：[本地 claude] crazyCombo · HH:mm', () => {
    const todo = db.createLocalCaptureTodo(baseInput)
    expect(todo.title).toMatch(/^\[本地 claude\] crazyCombo · \d{2}:\d{2}$/)
    expect(todo.workDir).toBe('/Users/me/projects/crazyCombo')
  })

  it('aiSessions[0] 包含 nativeSessionId + source=local-capture + 默认路由', () => {
    const todo = db.createLocalCaptureTodo({ ...baseInput, nativeSessionId: 'native-1b' })
    expect(todo.aiSessions).toHaveLength(1)
    const s = todo.aiSessions[0]
    expect(s.nativeSessionId).toBe('native-1b')
    expect(s.tool).toBe('claude')
    expect(s.source).toBe('local-capture')
    expect(s.status).toBe('running')
    expect(s.telegramRoute).toEqual({ chatId: 999 })
    expect(s.larkRoute).toBeNull()
  })

  it('codex + initialPrompt → 标题带 prompt 摘要', () => {
    const todo = db.createLocalCaptureTodo({
      ...baseInput,
      tool: 'codex',
      nativeSessionId: 'native-2',
      initialPrompt: '帮我看看 X 是什么意思 然后呢'
    })
    expect(todo.title).toMatch(/^\[本地 codex\] crazyCombo · "帮我看看 X 是什么意思 然后呢"$/)
  })

  it('长 prompt 截断到 30 字 + …', () => {
    const long = '这是一段非常非常长的提示词A B C D E F G H I J K L M N O P Q R'
    const todo = db.createLocalCaptureTodo({
      ...baseInput,
      tool: 'codex',
      nativeSessionId: 'native-2b',
      initialPrompt: long
    })
    // Just check structure: ends with …" and the part before … is ≤ 30 chars
    expect(todo.title).toMatch(/^\[本地 codex\] crazyCombo · ".{1,30}…"$/)
  })

  it('幂等：并发调用 5 次同 nativeSessionId 只建 1 张', () => {
    const inputs = Array.from({ length: 5 }, () => ({ ...baseInput, nativeSessionId: 'native-race' }))
    const results = inputs.map(input => db.createLocalCaptureTodo(input))
    const ids = new Set(results.map(t => t.id))
    expect(ids.size).toBe(1)
    const all = db.listTodos({}).filter(t =>
      Array.isArray(t.aiSessions) && t.aiSessions.some(s => s.nativeSessionId === 'native-race')
    )
    expect(all.length).toBe(1)
  })
})

describe('renameLocalCaptureTitleIfMatches', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('当前 title 仍是 Phase 1 模板时才 rename', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'n-rename-1',
      cwd: '/x/proj',
      defaults: {}
    })
    const ok = db.renameLocalCaptureTitleIfMatches(todo.id, '[本地 claude] proj · "帮我做 Y…"')
    expect(ok).toBe(true)
    expect(db.getTodo(todo.id).title).toBe('[本地 claude] proj · "帮我做 Y…"')
  })

  it('用户已经改过标题就不动', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'n-rename-2',
      cwd: '/x/proj',
      defaults: {}
    })
    db.updateTodo(todo.id, { title: '用户改的标题' })
    const ok = db.renameLocalCaptureTitleIfMatches(todo.id, '[本地 claude] proj · "应当被忽略…"')
    expect(ok).toBe(false)
    expect(db.getTodo(todo.id).title).toBe('用户改的标题')
  })

  it('不存在的 todoId 返回 false', () => {
    const ok = db.renameLocalCaptureTitleIfMatches(99999, '[本地 claude] x · "y"')
    expect(ok).toBe(false)
  })
})

describe('setAiSessionFields', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('能更新 aiSessions[i] 的 status / source / lastStopAt', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude', nativeSessionId: 'n-up-1', cwd: '/x', defaults: {}
    })
    const sid = todo.aiSessions[0].sessionId
    const ok = db.setAiSessionFields(todo.id, sid, {
      status: 'pending_confirm',
      lastStopAt: 1234567890,
      source: 'adopted'
    })
    expect(ok).toBe(true)
    const fresh = db.getTodo(todo.id).aiSessions[0]
    expect(fresh.status).toBe('pending_confirm')
    expect(fresh.lastStopAt).toBe(1234567890)
    expect(fresh.source).toBe('adopted')
    // 既有字段不被丢
    expect(fresh.nativeSessionId).toBe('n-up-1')
  })

  it('未知 sessionId 返回 false 且不破坏其它 session', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude', nativeSessionId: 'n-up-2', cwd: '/x', defaults: {}
    })
    const ok = db.setAiSessionFields(todo.id, 'no-such-sid', { status: 'done' })
    expect(ok).toBe(false)
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('running')
  })

  it('未知 todoId 返回 false', () => {
    const ok = db.setAiSessionFields(99999, 'sid', { status: 'done' })
    expect(ok).toBe(false)
  })
})
