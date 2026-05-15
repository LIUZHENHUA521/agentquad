import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawWizard } from '../src/openclaw-wizard.js'
import { createPendingQuestionCoordinator } from '../src/pending-questions.js'
import { normalizeConfig } from '../src/config.js'

function makeAi() {
  return {
    sessions: [],
    spawnSession(x) {
      this.sessions.push(x)
      return { sessionId: x.sessionId, reused: false }
    },
  }
}
function makeBridge() {
  const routes = new Map()
  return {
    routes,
    isEnabled: () => true,
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    postText: async () => ({ ok: true }),
    findSessionByRoute: () => null,
    getLastPushedSession: () => null,
    setLastPushedSession: () => true,
    clearLastPushForPeer: () => false,
  }
}
function makeWizard({ autoCreateTodo = true, withPty = true } = {}) {
  const db = openDb(':memory:')
  db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
  const ai = makeAi()
  const bridge = makeBridge()
  const pending = createPendingQuestionCoordinator({ db })
  const pty = withPty ? { has: () => false, write: () => {} } : undefined
  const wizard = createOpenClawWizard({
    db, aiTerminal: ai, openclaw: bridge, pending, pty,
    getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo } }),
  })
  return { db, ai, bridge, wizard }
}

describe('lark auto-create config', () => {
  it('DEFAULT_LARK_CONFIG sets autoCreateTodo to true', () => {
    const cfg = normalizeConfig({})
    expect(cfg.lark.autoCreateTodo).toBe(true)
  })

  it('user can opt out via explicit false', () => {
    const cfg = normalizeConfig({ lark: { autoCreateTodo: false } })
    expect(cfg.lark.autoCreateTodo).toBe(false)
  })

  it('any truthy value normalizes to retained', () => {
    const cfg = normalizeConfig({ lark: { autoCreateTodo: true } })
    expect(cfg.lark.autoCreateTodo).toBe(true)
  })
})

describe('lark no-prefix auto-create — fallback boundary', () => {
  it('#1 lark P2P 普通文本 → 起 wizard，title=原文', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '登录功能有 bug',  // 不命中 NEW_TASK_TRIGGERS（首字非动词列表）
    })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('登录功能有 bug')
    expect(r.reply).toContain('📁')
  })

  it('#6 lark P2P /help → fallback（slash 守门）', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '/help',
    })
    expect(r.action).toBe('fallback')
  })

  it('#7 lark P2P /wat（未知 slash）→ fallback', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '/wat',
    })
    expect(r.action).toBe('fallback')
  })

  it('#8 autoCreateTodo=false → fallback', async () => {
    const { wizard } = makeWizard({ autoCreateTodo: false })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '登录功能有 bug',  // 不命中 NEW_TASK_TRIGGERS
    })
    expect(r.action).toBe('fallback')
  })

  it('#9 telegram P2P 普通文本 → fallback（channel 隔离）', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'telegram', chatId: '12345', threadId: null,
      text: '登录功能有 bug',  // 不命中 NEW_TASK_TRIGGERS
    })
    expect(r.action).toBe('fallback')
  })

  it('#11 lark P2P + 多活跃 PTY → ambiguous（不起 wizard）', async () => {
    const db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    const ai2 = {
      sessions: new Map([
        ['s1', { sessionId: 's1', todoId: 1, status: 'running', startedAt: Date.now() }],
        ['s2', { sessionId: 's2', todoId: 1, status: 'running', startedAt: Date.now() - 1000 }],
      ]),
      spawnSession() { return { sessionId: 'x', reused: false } },
    }
    const bridge = makeBridge()
    const pending = createPendingQuestionCoordinator({ db })
    const w2 = createOpenClawWizard({
      db, aiTerminal: ai2, openclaw: bridge, pending,
      pty: { has: () => true, write: () => {} },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo: true } }),
    })
    const r = await w2.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '登录功能有 bug',  // 不命中 NEW_TASK_TRIGGERS
    })
    expect(r.action).toBe('stdin_proxy_ambiguous')
  })

  it('#12 纯图消息（text 为空）→ fallback（不起 wizard）', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '', imagePaths: ['/tmp/fake.jpg'],
    })
    expect(r.action).toBe('fallback')
  })
})

describe('lark no-prefix auto-create — unbound thread (notFound branch)', () => {
  it('#2a lark 群里未绑 session 的 thread 首条消息 → 起 wizard', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_grp', threadId: 'omt_new', rootMessageId: null,
      messageId: 'm1', text: '登录功能不对劲',  // 非 NEW_TASK_TRIGGERS
    })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('登录功能不对劲')
  })

  it('#2b 同上但 autoCreateTodo=false → 保留原 "没有找到对应运行中的任务"', async () => {
    const { wizard } = makeWizard({ autoCreateTodo: false })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_grp', threadId: 'omt_new', rootMessageId: null,
      messageId: 'm1', text: '没有匹配的普通文本',  // 非 NEW_TASK_TRIGGERS
    })
    expect(r.action).toBe('session_not_found')
    expect(r.reply).toContain('没有找到对应运行中的任务')
  })
})

describe('lark no-prefix auto-create — precedence guards', () => {
  it('#3 旧 "帮我做" 前缀仍走 step 3 NEW_TASK_TRIGGERS', async () => {
    const { wizard } = makeWizard()
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '帮我做 写个 demo',
    })
    expect(r.action).toBe('wizard_started')
    expect(r.reply).toContain('写个 demo')
  })

  it('#4 lastPush 命中 → 走 step 5 PTY，不起 wizard', async () => {
    const db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    const ai = makeAi()
    const bridge = makeBridge()
    bridge.getLastPushedSession = () => 'sid_recent'
    const writes = []
    const pty = { has: (sid) => sid === 'sid_recent', write: (sid, d) => writes.push({ sid, d }) }
    const pending = createPendingQuestionCoordinator({ db })
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo: true } }),
    })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '继续看一下',
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes.length).toBeGreaterThan(0)
  })

  it('#5 绑定 alive lark thread → 走 step 0 stdin proxy', async () => {
    const db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    const ai = makeAi()
    const bridge = makeBridge()
    bridge.findSessionByRoute = ({ chatId, threadId }) =>
      (chatId === 'oc_grp' && threadId === 'omt_alive') ? 'sid_alive' : null
    const writes = []
    const pty = { has: (sid) => sid === 'sid_alive', write: (sid, d) => writes.push({ sid, d }) }
    const pending = createPendingQuestionCoordinator({ db })
    const wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending, pty,
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, lark: { autoCreateTodo: true } }),
    })
    const r = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_grp', threadId: 'omt_alive', rootMessageId: 'm_root',
      messageId: 'm1', text: '改一下',
    })
    expect(r.action).toBe('stdin_proxy')
    expect(writes.length).toBeGreaterThan(0)
  })

  it('#10 auto-create 起 wizard 后回 "取消" → wizard 被中止', async () => {
    const { wizard } = makeWizard()
    const r1 = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm1',
      text: '登录功能有 bug',  // 非 NEW_TASK_TRIGGERS，强制走 auto-create
    })
    expect(r1.action).toBe('wizard_started')
    const r2 = await wizard.handleInbound({
      channel: 'lark', chatId: 'oc_p2p', threadId: null, messageId: 'm2',
      text: '取消',
    })
    expect(r2.action).toBe('wizard_cancelled')
  })
})
