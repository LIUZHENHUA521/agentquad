import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createAiTerminal } from '../src/routes/ai-terminal.js'

// 与 ai-terminal.route.test.js 同款 FakePty:不 spawn 真进程,手动触发事件
class FakePty extends EventEmitter {
  constructor() {
    super()
    this.started = []
    this._has = new Set()
    this._nativeIds = new Map()
  }
  create(opts) {
    this._has.add(opts.sessionId)
    if (opts.resumeNativeId) this._nativeIds.set(opts.sessionId, opts.resumeNativeId)
  }
  async startWithSize() {}
  async start(opts) {
    this.started.push(opts)
    this._has.add(opts.sessionId)
  }
  write() {}
  resize() {}
  stop(id) {
    this._has.delete(id)
    this.emit('done', { sessionId: id, exitCode: 0, fullLog: '', nativeId: null, stopped: true })
  }
  getNativeId(id) { return this._nativeIds.get(id) ?? null }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
  getPids() { return [] }
  // 默认 jsonl 都在磁盘:让 recovery 走 happy path,看 orphan sweep 是否会误伤 alive。
  findClaudeSession() { return { filePath: 'x.jsonl', cwd: null } }
}

function makeTerminal(db) {
  const pty = new FakePty()
  const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
  const ait = createAiTerminal({ db, pty, logDir })
  return { ait, pty, logDir }
}

describe('routes/ai-terminal markOrphanedSessionsAsFailed', () => {
  let cleanups = []
  beforeEach(() => { cleanups = [] })
  afterEach(() => {
    for (const fn of cleanups) {
      try { fn() } catch {}
    }
    cleanups = []
  })

  it('marks orphan running session as failed when no live PTY exists', () => {
    // ai_done todo 不进 recoverPendingTodosOnStartup 扫描,running aiSession 是真孤儿。
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const todo = db.createTodo({
      title: 'orphan-running',
      quadrant: 1,
      status: 'ai_done',
      aiSessions: [{
        sessionId: 'sess-running',
        tool: 'claude',
        nativeSessionId: 'native-running-uuid',
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'x',
      }],
    })
    const { ait, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    const updated = db.getTodo(todo.id)
    expect(updated.aiSession.status).toBe('failed')
    expect(updated.aiSession.completedAt).toBeTypeOf('number')
    // nativeSessionId 保留,让用户后续仍可 Resume
    expect(updated.aiSession.nativeSessionId).toBe('native-running-uuid')
  })

  it('marks orphan idle session as failed', () => {
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const todo = db.createTodo({
      title: 'orphan-idle',
      quadrant: 1,
      status: 'ai_done',
      aiSessions: [{
        sessionId: 'sess-idle',
        tool: 'cursor',
        nativeSessionId: 'native-idle-uuid',
        status: 'idle',
        startedAt: 1,
        completedAt: null,
        prompt: 'x',
      }],
    })
    const { ait, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    const updated = db.getTodo(todo.id)
    expect(updated.aiSession.status).toBe('failed')
  })

  it('marks orphan pending_confirm session as failed (via idle intermediate)', () => {
    // sweepStuckPendingConfirm 先把 pending_confirm → idle,
    // 然后 markOrphanedSessionsAsFailed 再把孤儿 idle → failed。
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const todo = db.createTodo({
      title: 'orphan-pending',
      quadrant: 1,
      status: 'ai_done',
      aiSessions: [{
        sessionId: 'sess-pending',
        tool: 'claude',
        nativeSessionId: 'native-pending-uuid',
        status: 'pending_confirm',
        startedAt: 1,
        completedAt: null,
        prompt: 'x',
      }],
    })
    const { ait, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    const updated = db.getTodo(todo.id)
    expect(updated.aiSession.status).toBe('failed')
  })

  it('does NOT mark successfully recovered session as failed', () => {
    // ai_running todo + 可恢复的 claude session → recoverPendingTodosOnStartup
    // 成功 spawn 并 set nativeSessionMap,orphan sweep 应该跳过这条。
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const workDir = mkdtempSync(join(tmpdir(), 'quadtodo-workdir-'))
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }))
    const sessionCwd = mkdtempSync(join(workDir, 'session-'))
    const todo = db.createTodo({
      title: 'alive',
      quadrant: 1,
      status: 'ai_running',
      workDir,
      aiSessions: [{
        sessionId: 'sess-alive',
        tool: 'claude',
        nativeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
        cwd: sessionCwd,
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'x',
      }],
    })
    const { ait, pty, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    // recovery 起了一个 PTY,sweep 后 aiSession 仍是 running
    expect(pty.started).toHaveLength(1)
    const updated = db.getTodo(todo.id)
    expect(updated.aiSession.status).toBe('running')
  })

  it('does NOT touch closed-state sessions (done / failed / stopped)', () => {
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const todo = db.createTodo({
      title: 'history',
      quadrant: 1,
      status: 'ai_done',
      aiSessions: [
        { sessionId: 's-done', tool: 'claude', nativeSessionId: 'n1', status: 'done', startedAt: 1, completedAt: 2, prompt: '' },
        { sessionId: 's-failed', tool: 'claude', nativeSessionId: 'n2', status: 'failed', startedAt: 1, completedAt: 2, prompt: '' },
        { sessionId: 's-stopped', tool: 'claude', nativeSessionId: 'n3', status: 'stopped', startedAt: 1, completedAt: 2, prompt: '' },
      ],
    })
    const { ait, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    const updated = db.getTodo(todo.id)
    const byId = Object.fromEntries((updated.aiSessions || []).map((s) => [s.sessionId, s.status]))
    expect(byId['s-done']).toBe('done')
    expect(byId['s-failed']).toBe('failed')
    expect(byId['s-stopped']).toBe('stopped')
  })

  it('handles aiSession without nativeSessionId (treated as orphan)', () => {
    // 早期 spawn 还没拿到 nativeSessionId 就 crash 了,DB 里留下 nativeSessionId=null
    // 的 running 记录,这种没法 Resume 但也不该卡在"运行中"。
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const todo = db.createTodo({
      title: 'orphan-no-native',
      quadrant: 1,
      status: 'ai_done',
      aiSessions: [{
        sessionId: 'sess-no-native',
        tool: 'cursor',
        nativeSessionId: null,
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'x',
      }],
    })
    const { ait, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    const updated = db.getTodo(todo.id)
    expect(updated.aiSession.status).toBe('failed')
  })

  it('sweeps mixed bag: one alive recovered + one orphan in history', () => {
    const db = openDb(':memory:')
    cleanups.push(() => db.close())
    const workDir = mkdtempSync(join(tmpdir(), 'quadtodo-workdir-'))
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }))
    const sessionCwd = mkdtempSync(join(workDir, 'session-'))
    // 注意 mergeTodoAiSessions: recovery 会以新 sessionId append + 过滤掉 tool+
    // nativeSessionId 重复的老记录,所以 alive 会话写新的 nativeSessionId,孤儿用
    // 另一个不冲突的 nativeSessionId,确保两条都保留可查。
    const todo = db.createTodo({
      title: 'mixed',
      quadrant: 1,
      status: 'ai_running',
      workDir,
      aiSessions: [
        { sessionId: 's-alive', tool: 'claude', nativeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
          cwd: sessionCwd, status: 'running', startedAt: 1, completedAt: null, prompt: '' },
        { sessionId: 's-old-zombie', tool: 'cursor', nativeSessionId: 'native-zombie',
          status: 'running', startedAt: 0, completedAt: null, prompt: '' },
      ],
    })
    const { ait, logDir } = makeTerminal(db)
    cleanups.push(() => { ait.close(); rmSync(logDir, { recursive: true, force: true }) })

    const updated = db.getTodo(todo.id)
    const byId = Object.fromEntries((updated.aiSessions || []).map((s) => [s.sessionId, s.status]))
    // alive 那条被 mergeTodoAiSessions 换成新 sessionId,其 status 仍是 running
    const runningEntries = (updated.aiSessions || []).filter((s) => s.status === 'running')
    expect(runningEntries).toHaveLength(1)
    expect(runningEntries[0].nativeSessionId).toBe('abcdef12-3456-7890-abcd-ef1234567890')
    // 孤儿被改成 failed
    expect(byId['s-old-zombie']).toBe('failed')
  })
})

describe('routes/ai-terminal recoverPendingTodosOnStartup spawn-failure catch', () => {
  it('marks aiSession failed when pty.start() rejects', async () => {
    const db = openDb(':memory:')
    const workDir = mkdtempSync(join(tmpdir(), 'quadtodo-workdir-'))
    const sessionCwd = mkdtempSync(join(workDir, 'session-'))
    const todo = db.createTodo({
      title: 'spawn-fail',
      quadrant: 1,
      status: 'ai_running',
      workDir,
      aiSessions: [{
        sessionId: 'old-session',
        tool: 'claude',
        nativeSessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
        cwd: sessionCwd,
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'x',
      }],
    })

    // 让 pty.start 异步 reject,触发 .catch(...) 路径
    const pty = new (class extends EventEmitter {
      constructor() { super(); this.started = [] }
      create() {}
      async startWithSize() {}
      async start() { throw new Error('boom') }
      write() {} resize() {} stop() {}
      getNativeId() { return null }
      has() { return false }
      list() { return [] }
      getPids() { return [] }
      findClaudeSession() { return { filePath: 'x.jsonl', cwd: null } }
    })()

    const logDir = mkdtempSync(join(tmpdir(), 'quadtodo-log-'))
    const ait = createAiTerminal({ db, pty, logDir })

    // pty.start 是异步 reject,catch 在下一个 microtask 才执行;markOrphanedSessionsAsFailed
    // 已经同步跑完了,可能已经把 'running' 改成 'failed'。等微任务队列 flush 一下
    // 让 .catch(...) 里的 markRecoveryFailed 也跑完,最终拿到一致状态。
    await new Promise((r) => setImmediate(r))

    const updated = db.getTodo(todo.id)
    // todo.status 被 catch 块改回 'todo'
    expect(updated.status).toBe('todo')
    // aiSession.status 被改成 'failed'(可能来自 catch 块,也可能来自 orphan sweep,
    // 两者最终结果一致——这是 defense in depth 的预期)
    const target = (updated.aiSessions || []).find((s) =>
      s?.nativeSessionId === 'abcdef12-3456-7890-abcd-ef1234567890',
    )
    expect(target).toBeDefined()
    expect(target.status).toBe('failed')

    ait.close()
    rmSync(logDir, { recursive: true, force: true })
    rmSync(workDir, { recursive: true, force: true })
    db.close()
  })
})
