import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/db.js'
import { createAiTerminal } from '../../src/routes/ai-terminal.js'
import { loadConfig, setConfigValue } from '../../src/config.js'

// 模拟 PtyManager：spawnSession 实际调用的是 pty.create(...) + pty.getNativeId(...) +
// pty.startWithSize(...)（兜底 timer 才用），加上事件订阅。FakePty 把这些方法都接上。
// `spawn` 属性保留是为了让 spawn_failed 测试可以覆写（实际生产路径不再走 pty.spawn）。
class FakePty extends EventEmitter {
  constructor() {
    super()
    this.created = []
    this.startedWithSize = []
    this.stopped = []
    this._has = new Set()
    this._nativeIds = new Map()
  }
  create(opts) {
    this.created.push(opts)
    this._has.add(opts.sessionId)
    if (opts.resumeNativeId) {
      this._nativeIds.set(opts.sessionId, opts.resumeNativeId)
    } else if (opts.tool === 'claude') {
      this._nativeIds.set(opts.sessionId, `claude-preset-${this.created.length}`)
    } else {
      this._nativeIds.set(opts.sessionId, null)
    }
  }
  async startWithSize(sessionId, cols, rows) {
    this.startedWithSize.push({ sessionId, cols, rows })
  }
  stop(id) {
    this.stopped.push(id)
    this._has.delete(id)
  }
  getNativeId(id) { return this._nativeIds.get(id) ?? null }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
  getPids() { return [] }
}

function makeApp(db, pty, opts = {}) {
  const rootDir = opts.rootDir
  // spawnSession 内部走 checkToolAvailable → 必须把 tools.<tool>.bin 指到一个真实存在的
  // 可执行文件（任何 POSIX 系统都有 /bin/sh），否则路由层会先返回 424 tool_missing 把测试搞糊。
  loadConfig({ rootDir })
  setConfigValue('tools.claude.bin', '/bin/sh', { rootDir })
  setConfigValue('tools.codex.bin', '/bin/sh', { rootDir })
  setConfigValue('tools.cursor.bin', '/bin/sh', { rootDir })
  const ait = createAiTerminal({
    db,
    pty,
    logDir: opts.logDir,
    defaultCwd: '/tmp',
    rootDir,
  })
  const app = express()
  app.use(express.json())
  app.use('/api/ai-terminal', ait.router)
  return app
}

describe('POST /api/ai-terminal/adopt-local', () => {
  let db, pty, app, rootDir, logDir
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'quadtodo-root-'))
    logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
    db = openDb(':memory:')
    pty = new FakePty()
    app = makeApp(db, pty, { rootDir, logDir })
  })

  it('source=local-capture → spawnSession 接管, source 翻 adopted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'quadtodo-cwd-'))
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'native-adopt',
      cwd,
      defaults: {}
    })
    const sid = todo.aiSessions[0].sessionId

    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: sid })

    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(r.body.sessionId).toBe(sid)
    expect(r.body.nativeSessionId).toBe('native-adopt')

    // 关键：spawnSession 通过 pty.create 走，挂上了 in-memory sessions Map +
    // todoSessionMap + nativeSessionMap，xterm WS / GET /sessions / stop-by-todo 才生效。
    expect(pty.created).toHaveLength(1)
    expect(pty.created[0].sessionId).toBe(sid)
    expect(pty.created[0].resumeNativeId).toBe('native-adopt')
    expect(pty.created[0].cwd).toBe(cwd)
    expect(pty.created[0].tool).toBe('claude')

    // source 字段被翻成 'adopted'；同时 spawnSession 已把 status 翻成 'ai_running'。
    const fresh = db.getTodo(todo.id)
    expect(fresh.status).toBe('ai_running')
    expect(fresh.aiSessions[0].sessionId).toBe(sid)
    expect(fresh.aiSessions[0].source).toBe('adopted')
    expect(fresh.aiSessions[0].nativeSessionId).toBe('native-adopt')

    rmSync(cwd, { recursive: true, force: true })
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

  it('pty.create 抛错 → 500 spawn_failed', async () => {
    // FakePty.create 替换为抛错版，模拟 spawnSession 内部 pty.create() 失败
    // （比如 cwd 不可达 / 工具进程启动报错）。spawnSession 自己会 try/catch 然后 throw，
    // 路由层应该兜成 500 + error: 'spawn_failed'。
    const failingPty = new FakePty()
    failingPty.create = () => { throw new Error('boom') }
    const failingRootDir = mkdtempSync(join(tmpdir(), 'quadtodo-root-fail-'))
    const failingLogDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-fail-'))
    const failingDb = openDb(':memory:')
    const failingApp = makeApp(failingDb, failingPty, { rootDir: failingRootDir, logDir: failingLogDir })

    const cwd = mkdtempSync(join(tmpdir(), 'quadtodo-cwd-fail-'))
    const todo = failingDb.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'native-fail',
      cwd,
      defaults: {}
    })
    const sid = todo.aiSessions[0].sessionId

    const r = await request(failingApp)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: sid })

    expect(r.status).toBe(500)
    expect(r.body.error).toBe('spawn_failed')

    rmSync(cwd, { recursive: true, force: true })
    rmSync(failingRootDir, { recursive: true, force: true })
    rmSync(failingLogDir, { recursive: true, force: true })
  })
})
