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
