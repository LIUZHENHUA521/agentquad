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
