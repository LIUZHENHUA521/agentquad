import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { EventEmitter } from 'node:events'
import { openDb } from '../../src/db.js'
import { createAiTerminal } from '../../src/routes/ai-terminal.js'

class FakePty extends EventEmitter {
  constructor() {
    super()
    this.created = []
  }
  spawn(spec) {
    this.created.push(spec)
    return { sessionId: spec.sessionId, ok: true }
  }
}

function makeApp(db, pty) {
  const ait = createAiTerminal({
    db,
    pty,
    logDir: '/tmp/aq-logs',
    defaultCwd: '/tmp'
  })
  const app = express()
  app.use(express.json())
  app.use('/api/ai-terminal', ait.router)
  return app
}

describe('POST /api/ai-terminal/adopt-local', () => {
  let db, pty, app
  beforeEach(() => {
    db = openDb(':memory:')
    pty = new FakePty()
    app = makeApp(db, pty)
  })

  it('source=local-capture → spawn 含 resumeNativeId + source 翻 adopted', async () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'native-adopt',
      cwd: '/Users/me/proj',
      defaults: {}
    })
    const sid = todo.aiSessions[0].sessionId

    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: sid })

    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(pty.created).toHaveLength(1)
    expect(pty.created[0].resumeNativeId).toBe('native-adopt')
    expect(pty.created[0].sessionId).toBe(sid)
    expect(pty.created[0].cwd).toBe('/Users/me/proj')
    expect(pty.created[0].tool).toBe('claude')

    const fresh = db.getTodo(todo.id).aiSessions[0]
    expect(fresh.source).toBe('adopted')
  })

  it('source=web → 400 not_local_capture', async () => {
    const todo = db.createTodo({
      title: 'web',
      aiSessions: [{
        sessionId: 'sw',
        nativeSessionId: 'nw',
        tool: 'claude',
        status: 'running',
        source: 'web'
      }]
    })
    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: 'sw' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_local_capture')
    expect(pty.created).toHaveLength(0)
  })

  it('未知 sessionId → 404 session_not_found', async () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'native-a',
      cwd: '/x',
      defaults: {}
    })
    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: 'no-such' })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('session_not_found')
    expect(pty.created).toHaveLength(0)
  })

  it('未知 todoId → 404 todo_not_found', async () => {
    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: 99999, sessionId: 'x' })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('todo_not_found')
  })

  it('缺参 → 400 missing_params', async () => {
    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({})
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('missing_params')
  })
})
