import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'

function fakeBridge() {
  return {
    broadcastText: vi.fn().mockResolvedValue({ ok: true }),
    postCard: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    hasExplicitRoute: vi.fn().mockReturnValue(false),
    resolveRoute: vi.fn().mockReturnValue(null)
  }
}

function bridgeWithLarkRoute() {
  const routes = new Map()
  return {
    broadcastText: vi.fn(async ({ sessionId }) => {
      const route = routes.get(sessionId)
      return route?.rootMessageId ? { ok: true } : { ok: false, reason: 'misconfigured' }
    }),
    postCard: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    hasExplicitRoute: vi.fn((sessionId) => routes.has(sessionId)),
    resolveRoute: vi.fn((sessionId, channel = null) => {
      const route = routes.get(sessionId) || null
      if (!route) return null
      if (channel && route.channel !== channel) return null
      return route
    }),
    registerSessionRoute: vi.fn((sessionId, route) => {
      routes.set(sessionId, { ...route, channel: route.channel || 'lark' })
    })
  }
}

function makeHandler({ db, autoCapture = true } = {}) {
  return createOpenClawHookHandler({
    db,
    config: {
      localSessions: {
        autoCapture: { enabled: autoCapture, redactCwd: 'basename' },
        defaultTelegramRoute: { chatId: 42 },
        defaultLarkRoute: null,
        skipEnvVar: 'AGENTQUAD_SKIP_CAPTURE'
      }
    },
    openclaw: fakeBridge(),
    codexBridge: fakeBridge(),
    aiTerminal: { sessions: new Map() },
    nowFn: () => new Date('2026-05-23T14:35:00Z')
  })
}

describe('openclaw-hook local capture', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('无匹配 todo + autoCapture on + claude SessionStart → 建一张 todo', async () => {
    const handler = makeHandler({ db })
    const result = await handler.handle({
      source: 'claude',
      path: 'hook-event',
      hookPayload: {
        hook_event_name: 'SessionStart',
        session_id: 'native-fresh',
        cwd: '/Users/me/proj-A',
        tool: 'claude'
      }
    })
    const todo = db.findTodoByNativeSessionId('native-fresh')
    expect(result.ok).toBe(true)
    expect(result.action).toBe('captured')
    expect(todo).not.toBeNull()
    expect(todo.title).toMatch(/^\[本地 claude\] proj-A · \d{2}:\d{2}$/)
    expect(todo.aiSessions[0].telegramRoute).toEqual({ chatId: 42 })
    expect(todo.aiSessions[0].source).toBe('local-capture')
  })

  it('autoCapture off → 不建 todo', async () => {
    const handler = makeHandler({ db, autoCapture: false })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-x', cwd: '/x', tool: 'claude' }
    })
    expect(db.findTodoByNativeSessionId('native-x')).toBeNull()
  })

  it('env 含 AGENTQUAD_SKIP_CAPTURE=1 → 不建', async () => {
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: {
        hook_event_name: 'SessionStart',
        session_id: 'native-skip',
        cwd: '/x',
        tool: 'claude',
        env: { AGENTQUAD_SKIP_CAPTURE: '1' }
      }
    })
    expect(db.findTodoByNativeSessionId('native-skip')).toBeNull()
  })

  it('已绑定 todo → 不重复建', async () => {
    const existing = db.createTodo({
      title: '已有',
      aiSessions: [{ sessionId: 's1', nativeSessionId: 'native-bound', tool: 'claude', status: 'running' }]
    })
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-bound', cwd: '/x', tool: 'claude' }
    })
    const all = db.listTodos({})
    expect(all.length).toBe(1)
    expect(all[0].id).toBe(existing.id)
  })

  it('codex UserPromptSubmit 带 prompt → 一次性带摘要建卡', async () => {
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'codex', path: 'hook-event',
      hookPayload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'native-codex-1',
        cwd: '/Users/me/proj-B',
        tool: 'codex',
        prompt: '帮我写一个 hello world'
      }
    })
    const todo = db.findTodoByNativeSessionId('native-codex-1')
    expect(todo).not.toBeNull()
    expect(todo.title).toMatch(/^\[本地 codex\] proj-B · "帮我写一个 hello world"$/)
  })

  it('Phase 2 rename：claude SessionStart 后 UserPromptSubmit 把标题加上摘要', async () => {
    const handler = makeHandler({ db })
    // Phase 1
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-rename', cwd: '/x/proj-C', tool: 'claude' }
    })
    const phase1 = db.findTodoByNativeSessionId('native-rename')
    expect(phase1.title).toMatch(/^\[本地 claude\] proj-C · \d{2}:\d{2}$/)

    // Phase 2 — first UserPromptSubmit
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'native-rename',
        cwd: '/x/proj-C',
        tool: 'claude',
        prompt: '看看 X 是啥'
      }
    })
    const phase2 = db.findTodoByNativeSessionId('native-rename')
    expect(phase2.title).toBe('[本地 claude] proj-C · "看看 X 是啥"')
  })

  it('Phase 2 不覆盖用户手改的标题', async () => {
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-edited', cwd: '/x/proj-D', tool: 'claude' }
    })
    const t = db.findTodoByNativeSessionId('native-edited')
    db.updateTodo(t.id, { title: '我自己改的标题' })

    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'native-edited',
        cwd: '/x/proj-D',
        tool: 'claude',
        prompt: 'ignored'
      }
    })
    expect(db.getTodo(t.id).title).toBe('我自己改的标题')
  })

  it('本地 claude Stop 等待异步 Lark 路由绑定后再推送首轮消息', async () => {
    const bridge = bridgeWithLarkRoute()
    const handler = createOpenClawHookHandler({
      db,
      config: {
        localSessions: {
          autoCapture: { enabled: true, redactCwd: 'basename' },
          defaultTelegramRoute: null,
          defaultLarkRoute: { targetUserId: 'oc_chat_x', rootMessageId: 'om_pending', channel: 'lark' },
          skipEnvVar: 'AGENTQUAD_SKIP_CAPTURE'
        }
      },
      openclaw: bridge,
      codexBridge: bridge,
      aiTerminal: { sessions: new Map() },
      onSessionSpawned: async ({ sessionId, todoId }) => {
        const todo = db.getTodo(todoId)
        const session = todo.aiSessions.find(item => item.sessionId === sessionId)
        db.setAiSessionFields(todoId, sessionId, {
          larkRoute: {
            ...(session.larkRoute || {}),
            targetUserId: 'oc_chat_x',
            rootMessageId: 'om_root',
            channel: 'lark'
          }
        })
      },
      nowFn: () => new Date('2026-05-23T14:35:00Z')
    })

    const result = await handler.handle({
      source: 'claude',
      path: 'hook-event',
      hookPayload: {
        hook_event_name: 'Stop',
        session_id: 'native-lark-first-stop',
        cwd: '/Users/me/proj-L',
        tool: 'claude'
      }
    })

    expect(result.ok).toBe(true)
    expect(result.action).toBe('sent')
    expect(bridge.registerSessionRoute).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ channel: 'lark', rootMessageId: 'om_root' }))
    expect(bridge.broadcastText).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String) }))
  })
})

describe('local capture status mapping', () => {
  let db, handler
  beforeEach(() => {
    db = openDb(':memory:')
    handler = makeHandler({ db })
  })

  async function fire(event, extra = {}) {
    await handler.handle({
      source: extra.tool === 'codex' ? 'codex' : 'claude',
      path: 'hook-event',
      hookPayload: {
        hook_event_name: event,
        session_id: 'native-status',
        cwd: '/x',
        tool: extra.tool || 'claude',
        ...extra.payload
      }
    })
  }

  it('claude SessionStart → running', async () => {
    await fire('SessionStart')
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).toBe('running')
  })

  it('claude Notification → pending_confirm', async () => {
    await fire('SessionStart')
    await fire('Notification', { payload: { message: '需要批准 Bash', tool_input: { command: 'ls' } } })
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).toBe('pending_confirm')
  })

  it('claude Stop → idle + lastStopAt', async () => {
    await fire('SessionStart')
    await fire('Stop')
    const s = db.findTodoByNativeSessionId('native-status').aiSessions[0]
    expect(s.status).toBe('idle')
    expect(s.lastStopAt).toBeGreaterThan(0)
  })

  it('claude SessionEnd → done + completedAt', async () => {
    await fire('SessionStart')
    await fire('SessionEnd')
    const s = db.findTodoByNativeSessionId('native-status').aiSessions[0]
    expect(s.status).toBe('done')
    expect(s.completedAt).toBeGreaterThan(0)
  })

  it('codex Stop → idle 且记录 lastStopAt', async () => {
    await fire('UserPromptSubmit', { tool: 'codex', payload: { prompt: 'hi' } })
    await fire('Stop', { tool: 'codex' })
    const s = db.findTodoByNativeSessionId('native-status').aiSessions[0]
    expect(s.status).toBe('idle')
    expect(s.lastStopAt).toBeGreaterThan(0)
  })

  it('codex 不进 pending_confirm', async () => {
    await fire('UserPromptSubmit', { tool: 'codex', payload: { prompt: 'hi' } })
    await fire('Stop', { tool: 'codex' })
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).not.toBe('pending_confirm')
  })

  it('source=web 的 session 不被 hook 翻状态（保护现有 PTY 状态机）', async () => {
    // 模拟 web 端建的 session：先手动建一个 source='web' 的 todo
    const todo = db.createTodo({
      title: 'web-session',
      aiSessions: [{
        sessionId: 'web-sid',
        nativeSessionId: 'native-web-1',
        tool: 'claude',
        status: 'running',
        source: 'web'
      }]
    })
    // 触发 Stop hook
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'Stop', session_id: 'native-web-1', cwd: '/x', tool: 'claude' }
    })
    // status 不应被翻成 idle —— web session 由 PTY 状态机管理
    const s = db.getTodo(todo.id).aiSessions[0]
    expect(s.status).toBe('running')
    expect(s.lastStopAt).toBeUndefined()
  })
})
