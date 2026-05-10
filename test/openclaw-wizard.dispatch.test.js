import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawWizard } from '../src/openclaw-wizard.js'
import { createPendingQuestionCoordinator } from '../src/pending-questions.js'

function makeFakeAi() {
  const sessions = []
  return {
    sessions,
    spawnSession({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv }) {
      sessions.push({ sessionId, todoId, prompt, tool, cwd, label, permissionMode, extraEnv })
      return { sessionId, reused: false }
    },
  }
}

function makeFakeBridge() {
  const routes = new Map()
  return {
    routes,
    isEnabled: () => true,
    registerSessionRoute: (sid, info) => routes.set(sid, info),
    postText: vi.fn(async () => ({ ok: true })),
  }
}

describe('openclaw-wizard dispatch resolution', () => {
  let db, wizard, ai, bridge, pending

  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo({ title: 'seed', quadrant: 1, workDir: '/tmp/foo' })
    ai = makeFakeAi()
    bridge = makeFakeBridge()
    pending = createPendingQuestionCoordinator({ db })
  })

  it('resolves tool=codex when dispatch.lark.perUser hits the inbound fromUserId', async () => {
    const cfg = {
      defaultCwd: '/tmp',
      port: 5677,
      defaultTool: 'claude',
      dispatch: {
        lark: { default: 'claude', perUser: { 'open_a': 'codex' } },
        telegram: { default: 'claude' },
        web: { default: 'claude' },
      },
    }
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => cfg,
    })

    // Drive the wizard to completion: workdir hint + quadrant 1 + free template (option 6)
    let r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_x',
      fromUserId: 'open_a',
      text: '帮我做 写个 demo 目录 /tmp/foo',
    })
    expect(r.reply).toContain('🎯 选象限')

    r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_x',
      fromUserId: 'open_a',
      text: '1',
    })
    expect(r.reply).toContain('📋 选模板')

    r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_x',
      fromUserId: 'open_a',
      text: '6',
    })
    expect(r.action).toBe('wizard_done')
    expect(ai.sessions).toHaveLength(1)
    expect(ai.sessions[0].tool).toBe('codex')
  })

  it('falls back to channel default when fromUserId not in perUser', async () => {
    const cfg = {
      defaultCwd: '/tmp',
      port: 5677,
      defaultTool: 'claude',
      dispatch: {
        lark: { default: 'codex' },
      },
    }
    wizard = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      getConfig: () => cfg,
    })

    let r = await wizard.handleInbound({
      channel: 'lark',
      chatId: 'oc_chat_y',
      fromUserId: 'open_b',
      text: '帮我做 写个 demo 目录 /tmp/foo',
    })
    expect(r.reply).toContain('🎯 选象限')
    r = await wizard.handleInbound({ channel: 'lark', chatId: 'oc_chat_y', fromUserId: 'open_b', text: '1' })
    r = await wizard.handleInbound({ channel: 'lark', chatId: 'oc_chat_y', fromUserId: 'open_b', text: '6' })
    expect(r.action).toBe('wizard_done')
    expect(ai.sessions[0].tool).toBe('codex')
  })
})
