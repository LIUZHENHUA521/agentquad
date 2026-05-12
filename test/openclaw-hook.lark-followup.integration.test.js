/**
 * 集成测试：复现"飞书第二条消息没投递到 Claude"的 bug。
 *
 * 用户场景：
 *   1. 第一条 lark 消息触发 wizard → 创建任务 → spawn PTY → 跑 Claude
 *   2. Claude 完成首轮（Stop hook fire） → 推送回 lark ✓
 *   3. 用户发"不错呀" → wizard 路由到 dispatcher → 应直写 PTY
 *   4. 实际：dispatcher 返回 'queued'，飞书显示"🔄 当前任务进行中，已排队"
 *
 * 这个测试用真实的 ai-terminal + dispatcher + openclaw-hook handler，
 * 配 FakePty，验证 Stop 后 awaitingReply 有没有被正确置 true。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createAiTerminal } from '../src/routes/ai-terminal.js'
import { createSessionInputDispatcher } from '../src/session-input-dispatcher.js'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'
import { createOpenClawBridge } from '../src/openclaw-bridge.js'
import { setConfigValue, loadConfig } from '../src/config.js'

class FakePty extends EventEmitter {
  constructor() {
    super()
    this.started = []
    this.startedWithSize = []
    this.writes = []
    this._has = new Set()
    this._nativeIds = new Map()
  }
  create(opts) {
    this.started.push(opts)
    this._has.add(opts.sessionId)
    if (opts.resumeNativeId) {
      this._nativeIds.set(opts.sessionId, opts.resumeNativeId)
    } else if (opts.tool === 'claude') {
      this._nativeIds.set(opts.sessionId, `claude-preset-${this.started.length}`)
    } else {
      this._nativeIds.set(opts.sessionId, null)
    }
  }
  startWithSize(sessionId, cols, rows) { this.startedWithSize.push({ sessionId, cols, rows }) }
  start(opts) { this.create(opts); this.startWithSize(opts.sessionId, 80, 24) }
  write(id, data) { this.writes.push({ id, data }) }
  resize() {}
  stop(id) {
    this._has.delete(id)
    this.emit('done', { sessionId: id, exitCode: 0, fullLog: '', nativeId: null, stopped: true })
  }
  getNativeId(id) { return this._nativeIds.get(id) ?? null }
  has(id) { return this._has.has(id) }
  list() { return [...this._has] }
  getPids() { return [] }
  findClaudeSession() { return null }
}

function setupAll(rootDir) {
  loadConfig({ rootDir })
  setConfigValue('tools.claude.bin', '/bin/sh', { rootDir })
  setConfigValue('lark.enabled', true, { rootDir })
  setConfigValue('lark.chatId', 'oc_chat_x', { rootDir })

  const db = openDb(':memory:')
  const pty = new FakePty()
  const logDir = mkdtempSync(join(tmpdir(), 'qt-log-'))
  const ait = createAiTerminal({ db, pty, logDir, rootDir })

  const bridge = createOpenClawBridge({
    getConfig: () => loadConfig({ rootDir }),
    larkBot: { replyInThread: async () => ({ ok: true, payload: { message_id: 'om_reply' } }) },
    logger: { warn() {}, info() {} },
  })

  const dispatcher = createSessionInputDispatcher({
    pty, aiTerminal: ait,
    callbacks: {
      onQueueFirstEnqueue: async () => undefined,
      onQueueAdditionalEnqueue: async () => undefined,
      onFlush: async () => undefined,
    },
    logger: { warn() {}, info() {} },
  })

  const hookHandler = createOpenClawHookHandler({
    db, openclaw: bridge, aiTerminal: ait, pty,
    sessionInputDispatcher: dispatcher,
    getConfig: () => loadConfig({ rootDir }),
  })

  return { db, pty, ait, bridge, dispatcher, hookHandler, logDir }
}

describe('lark followup integration: Stop → 第二条消息应直发 PTY', () => {
  let ctx, rootDir
  beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'qt-root-')); ctx = setupAll(rootDir) })
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(ctx.logDir, { recursive: true, force: true })
  })

  it('Stop hook 后 awaitingReply=true → dispatcher 直写 PTY，不应 queued', async () => {
    const { db, ait, bridge, dispatcher, hookHandler, pty } = ctx

    // 1) 模拟 wizard 落地：建 todo → spawn 一个 session
    const todo = db.createTodo({ title: '写一首短诗', quadrant: 2 })
    const r = ait.spawnSession({
      todoId: todo.id, prompt: '写一首短诗', tool: 'claude',
      sessionId: 'ai-test-3em7', skipTelegram: true,
    })
    const sid = r.sessionId

    // 2) wizard 注册 lark route（finalizeWizard 那段干的事）
    bridge.registerSessionRoute(sid, {
      channel: 'lark', targetUserId: 'oc_chat_x', rootMessageId: 'om_root',
    })

    // 状态前置断言：刚 spawn，awaitingReply=false（still busy until first Stop）
    expect(ait.isSessionAwaitingReply(sid)).toBe(false)
    expect(pty.has(sid)).toBe(true)

    // 3) Claude 完成首轮 → Stop hook fire（模拟 notify.js POST 到 server）
    const stopResult = await hookHandler.handle({
      event: 'stop', sessionId: sid, todoId: todo.id, todoTitle: '写一首短诗',
    })
    expect(stopResult.ok).toBe(true)
    expect(stopResult.action).toBe('sent')

    // 4) Stop 之后 → awaitingReply 应该是 true（这是关键断言）
    expect(ait.isSessionAwaitingReply(sid)).toBe(true)

    // 5) 用户发"不错呀" → dispatcher.send → 应直写 PTY，返回 sent，不应 queued
    const sendResult = await dispatcher.send({
      sessionId: sid, text: '不错呀', channel: 'lark',
      echoTarget: { chatId: 'oc_chat_x', rootMessageId: 'om_root' },
    })
    expect(sendResult.action).toBe('sent')
    expect(sendResult.action).not.toBe('queued')

    // PTY 应该收到了用户输入
    const userWrite = pty.writes.find((w) => w.id === sid && w.data === '不错呀')
    expect(userWrite).toBeDefined()
  })

  it('修复后：web UI 通过 WS 发非提交字符（focus 序列、单字符）不再翻 awaitingReply → 飞书消息照样能直发', async () => {
    // 历史 bug：handleBrowserMessage 无条件 awaitingReply=false，xterm focus 序列
    // (\x1b[I)、用户在终端慢慢打字、粘贴中间态都会把 idle 状态吃掉，导致后续
    // IM 消息被 queue 卡住。修复后只在真正的提交键（Enter / Ctrl+C / Ctrl+D）才翻。
    const { db, ait, bridge, dispatcher, hookHandler, pty } = ctx

    const todo = db.createTodo({ title: 'repro', quadrant: 2 })
    const r = ait.spawnSession({
      todoId: todo.id, prompt: 'hi', tool: 'claude',
      sessionId: 'ai-test-repro', skipTelegram: true,
    })
    const sid = r.sessionId
    bridge.registerSessionRoute(sid, {
      channel: 'lark', targetUserId: 'oc_chat_x', rootMessageId: 'om_root',
    })

    await hookHandler.handle({ event: 'stop', sessionId: sid, todoId: todo.id, todoTitle: 'repro' })
    expect(ait.isSessionAwaitingReply(sid)).toBe(true)

    // 模拟 web UI 各种"幽灵 input"，都不该翻 awaitingReply
    ait.handleBrowserMessage(sid, { type: 'input', data: '\x1b[I' }, { send() {}, close() {} })
    ait.handleBrowserMessage(sid, { type: 'input', data: 'a' }, { send() {}, close() {} })
    ait.handleBrowserMessage(sid, { type: 'input', data: 'bc' }, { send() {}, close() {} })
    expect(ait.isSessionAwaitingReply(sid)).toBe(true)

    // 这之后 dispatcher.send 必须直发，不能 queue
    const sendResult = await dispatcher.send({
      sessionId: sid, text: '不错呀', channel: 'lark',
      echoTarget: { chatId: 'oc_chat_x', rootMessageId: 'om_root' },
    })
    expect(sendResult.action).toBe('sent')
    const userWrite = pty.writes.find((w) => w.id === sid && w.data === '不错呀')
    expect(userWrite).toBeDefined()
  })
})
