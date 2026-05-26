import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createOpenClawHookHandler, __test__ } from '../src/openclaw-hook.js'
import { createOpenClawHookRouter } from '../src/routes/openclaw-hook.js'
import { DEFAULT_PRICING } from '../src/pricing.js'

// 默认带一个 fake non-interactive route（channel='openclaw-weixin' 让
// resolveExplicitInteractiveRoute 返回 null，保留 permission-reminder 路径的原行为）。
// 想测"完全没绑 IM"的快路径，显式传 `{ route: null }`。
function makeFakeBridge({
  sendOk = true,
  sendReason = null,
  route = { channel: 'openclaw-weixin', targetUserId: 'wx-default' },
  explicitRoute = route != null,
} = {}) {
  const sent = []
  const routes = new Map()
  return {
    sent,
    routes,
    isEnabled: () => true,
    hasExplicitRoute: vi.fn((sessionId) => Boolean(sessionId && routes.has(sessionId)) || explicitRoute),
    resolveRoute: vi.fn((sessionId) => routes.get(sessionId) || route),
    registerSessionRoute: vi.fn((sessionId, routeInfo) => {
      routes.set(sessionId, routeInfo)
    }),
    postText: vi.fn(async ({ sessionId, message, replyMarkup }) => {
      sent.push({ sessionId, message, replyMarkup, route: routes.get(sessionId) || route })
      if (sendOk) return { ok: true }
      return { ok: false, reason: sendReason || 'cli_failed' }
    }),
    broadcastText: vi.fn(async ({ sessionId, message, replyMarkup }) => {
      sent.push({ sessionId, message, replyMarkup, route: routes.get(sessionId) || route })
      if (sendOk) return { ok: true }
      return { ok: false, reason: sendReason || 'cli_failed' }
    }),
  }
}

describe('openclaw-hook helpers', () => {
  it('shortTodoId takes last 3 alphanumeric chars lowercase', () => {
    expect(__test__.shortTodoId('todo-abc-XYZ')).toBe('xyz')
    expect(__test__.shortTodoId('a3f-9d8-fff')).toBe('fff')
    expect(__test__.shortTodoId('')).toBeNull()
    expect(__test__.shortTodoId(null)).toBeNull()
  })

  it('buildMessage: stop with body returns body verbatim (no prefix/footer noise)', () => {
    const stop = __test__.buildMessage({ event: 'stop', cleanContent: '修复完成，已经 commit。' })
    expect(stop).toBe('修复完成，已经 commit。')
    expect(stop).not.toContain('AI 一轮结束')
    expect(stop).not.toContain('直接在这里回我')
  })

  it('buildMessage: notification keeps ⚠️ prefix (status signal)', () => {
    const notif = __test__.buildMessage({ event: 'notification', snippet: 'pwd?' })
    expect(notif).toContain('⚠️')
    expect(notif).toContain('pwd?')
  })

  it('buildMessage: session-end keeps ✅ prefix', () => {
    const end = __test__.buildMessage({ event: 'session-end', cleanContent: '收工。' })
    expect(end).toContain('✅')
    expect(end).toContain('收工。')
  })

  it('buildMessage: stop without body falls back to placeholder', () => {
    const m = __test__.buildMessage({ event: 'stop' })
    expect(m).toContain('🤖')
    expect(m).toContain('无新内容')
  })

  // 实战回归 1：cursor TUI 底部状态栏（model selector / Auto-run / cwd · branch）
  // 每次 stop 都出现在 PTY tail，没信息量但占大半 IM 消息正文。要全部 strip。
  it('extractTailSnippet filters Cursor TUI status bar noise (model / Auto-run / cwd-branch)', () => {
    const raw = [
      '问：1+1 等于几？',
      '答：2',
      '',
      'Opus 4.6 (Thinking) 200K High · 23.6%',
      'Auto-run',
      '  ~/Desktop/code/crazyCombo/quadtodo · main',
      'Opus 4.6 (Thinking) 200K High · 64%',
      'Auto-run',
      '~/Desktop/code/crazyCombo/quadtodo · main',
    ].join('\n')
    const out = __test__.extractTailSnippet(raw)
    expect(out).toContain('答：2')
    expect(out).not.toMatch(/Opus 4\.6/)
    expect(out).not.toMatch(/Auto-run/)
    expect(out).not.toMatch(/quadtodo · main/)
  })

  it('buildMessage strips box-drawing chars from snippet', () => {
    const ugly = '╭─────╮\n│ abc │\n╰─────╯\n请回 a/b/c'
    const m = __test__.buildMessage({ event: 'stop', todoId: 'x', todoTitle: 'T', snippet: ugly })
    expect(m).not.toMatch(/[╭╮╰╯─│]/)
    expect(m).toContain('请回 a/b/c')
  })

  it('buildMessage compacts blank lines', () => {
    const m = __test__.buildMessage({
      event: 'stop',
      todoId: 'x', todoTitle: 'T',
      snippet: 'line1\n\n\n\n\nline2',
    })
    expect(m).not.toContain('\n\n\n')
    expect(m).toContain('line1\n\nline2')
  })

  it('buildMessage with snippet skips the legacy "去 Web UI 看" hint', () => {
    const m = __test__.buildMessage({ event: 'stop', todoId: 'x', todoTitle: 'T', snippet: 'something' })
    expect(m).not.toContain('Web UI')
    expect(m).toContain('something')
  })

  it('extractTailSnippet filters Claude Code spinner / status / border lines', () => {
    const ugly = `
请告诉我 bug 现象：
| a | 登录后白屏 |
| b | 登录失败 |
| c | 账号不存在 |
✶
✳
Drizzling…
✻
Cooked for 3m 28s
----------------------------------------
❯
⏵⏵ auto mode on (shift+tab to cycle)
`
    const m = __test__.buildMessage({ event: 'notification', todoId: 'x', todoTitle: 'T', snippet: ugly })
    expect(m).toContain('请告诉我 bug 现象')
    expect(m).toContain('登录后白屏')
    expect(m).not.toContain('✶')
    expect(m).not.toContain('Drizzling')
    expect(m).not.toContain('Cooked for')
    expect(m).not.toContain('auto mode')
    expect(m).not.toContain('❯')
  })

  it('extractTailSnippet falls back to historicalRaw when recentOutput is all spinner', () => {
    const allSpinner = '✶\n✳\nDrizzling…\nCooked for 5m\n❯\n⏵⏵ auto mode on'
    const realContent = '请选择 a/b/c：\n| a | 登录白屏 |\n| b | 登录失败 |\n| c | 账号不存在 |'
    const m = __test__.buildMessage({
      event: 'notification', todoId: 'x', todoTitle: 'T',
      snippet: allSpinner,
      historicalRaw: realContent + '\n' + allSpinner,
    })
    expect(m).toContain('请选择 a/b/c')
    expect(m).toContain('登录白屏')
  })

  it('extractTailSnippet returns empty when nothing meaningful and no fallback', () => {
    const m = __test__.buildMessage({
      event: 'notification', todoId: 'x', todoTitle: 'T',
      snippet: '✶\n✳\nDrizzling…\nCooked for 3m',
    })
    expect(m).toContain('AI 还在思考')
    expect(m).not.toContain('Drizzling')
  })

  it('filters unknown spinner verbs via generic ellipsis pattern', () => {
    // Claude Code 不断加新动词 —— Skedaddling 不在词典里但应被通用规则过滤
    const ugly = `
请告诉我答案：
| a | 选 a |
| b | 选 b |
✶Skedaddling…
✶Schmoozing…
✻Marinating…
*Bedazzling…
✻Cooked for 5m 12s
`
    const m = __test__.buildMessage({
      event: 'stop', todoId: 'x', todoTitle: 'T', snippet: ugly,
    })
    expect(m).toContain('请告诉我答案')
    expect(m).toContain('选 a')
    expect(m).not.toContain('Skedaddling')
    expect(m).not.toContain('Schmoozing')
    expect(m).not.toContain('Marinating')
    expect(m).not.toContain('Bedazzling')
    expect(m).not.toContain('Cooked for')
  })

  it('filters lines that look like generic Verbing/Verbed + ellipsis', () => {
    expect(__test__.buildMessage({
      event: 'notification', todoId: 'x', todoTitle: 'T',
      snippet: 'Whirring…\nGyrating…\nSpinning…',
    })).toContain('AI 还在思考')   // 全部被滤掉，回退到占位
  })

  it('keeps lines that look like real content (not status-shaped)', () => {
    const m = __test__.buildMessage({
      event: 'stop', todoId: 'x', todoTitle: 'T',
      snippet: 'I have completed the task.\nThe answer is X.\nNext step: review.',
    })
    expect(m).toContain('I have completed the task')
    expect(m).toContain('Next step: review')
  })
})

describe('openclaw-hook handler', () => {
  let db, bridge, handler

  beforeEach(() => {
    db = openDb(':memory:')
    // 默认 bridge 带一个 fake non-interactive route，模拟 session 已绑 IM —— 这是这个
    // describe 块下大多数测试的隐含前提；想测"无 IM"快路径的用例显式 override。
    // 用 openclaw-weixin（非 telegram 且无 threadId）避免 resolveExplicitInteractiveRoute
    // 误判为 permission-eligible，影响 notification suppress 测试。
    bridge = makeFakeBridge({ route: { channel: 'openclaw-weixin', targetUserId: 'wx-default' } })
    handler = createOpenClawHookHandler({ db, openclaw: bridge, cooldownMs: 30000 })
  })

  it('sends a stop event when no pending and not on cooldown', async () => {
    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].message).toContain('🤖')
  })

  it('calls larkBot.clearReactionsForSession on stop event when route is lark', async () => {
    const clearReactionsForSession = vi.fn().mockResolvedValue({ ok: true, removed: 2 })
    bridge.routes.set('sid-lark', { channel: 'lark', targetUserId: 'oc_1', rootMessageId: 'om_root' })
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      larkBot: { clearReactionsForSession },
      cooldownMs: 30000,
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 'sid-lark',
      todoId: 't-lark',
      todoTitle: 'Lark task',
    })
    // 等微任务把 .catch 链跑完
    await new Promise((res) => setTimeout(res, 5))

    expect(r.ok).toBe(true)
    expect(clearReactionsForSession).toHaveBeenCalledWith('sid-lark')
  })

  it('does NOT call larkBot.clearReactionsForSession when route is telegram (only lark routes)', async () => {
    const clearReactionsForSession = vi.fn()
    bridge.routes.set('sid-tg', { channel: 'telegram', targetUserId: '-100', threadId: 12 })
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      larkBot: { clearReactionsForSession },
      cooldownMs: 30000,
    })

    await handler.handle({
      event: 'stop',
      sessionId: 'sid-tg',
      todoId: 't-tg',
      todoTitle: 'Telegram task',
    })
    await new Promise((res) => setTimeout(res, 5))

    expect(clearReactionsForSession).not.toHaveBeenCalled()
  })

  it('broadcasts turn_done for Stop events', async () => {
    const notifyTurnDone = vi.fn(() => true)
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(notifyTurnDone).toHaveBeenCalledWith('s1', {
      event: 'stop',
      status: 'idle',
      todoTitle: 'Task A',
    })
  })

  it('broadcasts turn_done even when Telegram/OpenClaw push fails', async () => {
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'rate_limited' })
    const notifyTurnDone = vi.fn(() => true)
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(false)
    expect(r.action).toBe('failed')
    expect(r.reason).toBe('rate_limited')
    expect(notifyTurnDone).toHaveBeenCalledWith('s1', {
      event: 'stop',
      status: 'idle',
      todoTitle: 'Task A',
    })
  })

  it('Stop marks awaitingReply=true + flushes dispatcher queue even when push fails', async () => {
    // 回归：之前这两步被错误地包在 if (result.ok) 里。push 失败（route 缺失/限流/网络抖）
    // 后 awaitingReply 永远是 false，dispatcher 把所有用户消息都回 "🔄 已排队"，永不恢复。
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'rate_limited' })
    const markSessionAwaitingReply = vi.fn()
    const onSessionIdle = vi.fn(async () => ({ flushed: 0 }))
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone: vi.fn(), markSessionAwaitingReply },
      sessionInputDispatcher: { onSessionIdle },
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's_push_fail',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(false)
    expect(r.reason).toBe('rate_limited')
    // 关键：尽管 push 失败，idle 状态和队列 flush 必须照常发生
    expect(markSessionAwaitingReply).toHaveBeenCalledWith('s_push_fail', true)
    expect(onSessionIdle).toHaveBeenCalledWith('s_push_fail')
  })

  it('does not let turn_done broadcast failures break Stop handling', async () => {
    const logger = { warn: vi.fn() }
    const notifyTurnDone = vi.fn(() => { throw new Error('ws failed') })
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
      logger,
    })

    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })

    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(logger.warn).toHaveBeenCalledWith('[openclaw-hook] notifyTurnDone failed: ws failed')
  })

  it('does not broadcast turn_done for non-Stop events', async () => {
    const notifyTurnDone = vi.fn(() => true)
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal: { notifyTurnDone },
      getConfig: () => ({ telegram: { notificationCooldownMs: 0 } }),
    })

    await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1', todoTitle: 'Task A' })
    await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1', todoTitle: 'Task A' })

    expect(notifyTurnDone).not.toHaveBeenCalled()
  })

  it('SUPPRESSES Stop when there is a pending ask_user for that session', async () => {
    // 先建一条 pending question 给 s1
    db.createPendingQuestion({
      ticket: 'a3f',
      sessionId: 's1',
      todoId: 't1',
      question: 'q',
      options: ['a', 'b'],
      timeoutMs: 60000,
    })
    const r = await handler.handle({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'A',
    })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('ask_user_pending')
    expect(bridge.sent).toHaveLength(0)
  })

  it('Stop on different session is NOT suppressed by another sessions pending', async () => {
    db.createPendingQuestion({
      ticket: 'a3f',
      sessionId: 's-other',
      todoId: 't0',
      question: 'q',
      options: ['a', 'b'],
      timeoutMs: 60000,
    })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
  })

  it('Stop has NO cooldown — multi-turn conversations all push through', async () => {
    // 多轮 AI 对话，每个 Stop 都该送达；之前的 30s cooldown 已废除
    const r1 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r1.action).toBe('sent')
    const r2 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r2.action).toBe('sent')
    const r3 = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r3.action).toBe('sent')
  })

  it('different events all bypass any cooldown', async () => {
    await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  // ── Notification 事件（Claude Code 的 Stop-后 idle 心跳 + mid-turn 通知）──
  //
  // 现行契约（2026-05 删掉 IM 推送后）：
  //   - 任何 evt='notification' 一律 skipped、reason='notification_im_disabled'
  //   - broadcastText 永不被调
  //   - markPendingConfirm 仍调（状态机自守，running → pending_confirm 才翻、idle 时 no-op）
  //   - 真权限框由 PTY detector 独立路径推 IM（handleClaudeDetector），不走 Notification
  //
  // 历史背景：Notification 之前会重复推 Stop 已经送出去的 AI 回复正文 + 套上"⚠️ 等待授权"，
  // 用户反馈纯负面（截图证据：1779780499757-oz3ddk.png）。整条 IM 推送链路连同 bypass guard、
  // notification cooldown、`suppressNotificationEvents` config 一起退役（`suppressPermissionNotifications`
  // 仍保留给 detector 路径作 escape hatch）。
  it('Notification: 默认 skip，永不推 IM（无 config / 无 session）', async () => {
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })
    expect(r.ok).toBe(true)
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_im_disabled')
    expect(bridge.broadcastText).not.toHaveBeenCalled()
  })

  it('Notification: 仍调 markPendingConfirm（让 web UI 在 mid-turn 时能显示"待确认"）', async () => {
    const sessionId = 'ai-any-notification'
    const markPendingConfirm = vi.fn()
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      aiTerminal: {
        sessions: new Map([[sessionId, { permissionMode: 'default', recentOutput: '', outputHistory: [] }]]),
        markPendingConfirm,
      },
    })

    const r = await handler.handle({
      event: 'notification', sessionId, todoId: 't1',
      hookPayload: { message: 'Claude is waiting for your input' },
    })

    expect(markPendingConfirm).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ source: 'claude-notification' }),
    )
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_im_disabled')
    expect(bridge.broadcastText).not.toHaveBeenCalled()
  })

  it('Notification: 不论 bypass / 路由类型 / TUI 文本 / config 配置，行为完全一致', async () => {
    // 一组多样化场景：bypass 模式、非 bypass、Telegram thread、Lark root、wechat 默认、
    // 真权限文案、空文本、cooldownMs=0 配置 —— 全部 skip。
    const scenarios = [
      { name: 'bypass + telegram + 真权限文案',
        route: { channel: 'telegram', threadId: 123 },
        session: { permissionMode: 'bypass', recentOutput: 'Do you want to allow this command?', outputHistory: [] },
        config: undefined },
      { name: 'default + lark + 真权限文案',
        route: { channel: 'lark', rootMessageId: 'om_root_xxx', targetUserId: 'oc_chat_xxx' },
        session: { permissionMode: 'default', recentOutput: 'Do you want to allow this command?', outputHistory: [] },
        config: undefined },
      { name: 'default + wechat + 空文本',
        route: { channel: 'wechat' },
        session: { permissionMode: 'default', recentOutput: '', outputHistory: [] },
        config: undefined },
      { name: '显式 notificationCooldownMs=0 配置（detector cooldown 关掉也不影响 Notification）',
        route: { channel: 'telegram', threadId: 123 },
        session: { permissionMode: 'default', recentOutput: '', outputHistory: [] },
        config: { telegram: { notificationCooldownMs: 0 } } },
    ]

    for (const sc of scenarios) {
      const sid = `ai-${sc.name}`
      const b = makeFakeBridge({ route: sc.route })
      const h = createOpenClawHookHandler({
        db, openclaw: b,
        ...(sc.config ? { getConfig: () => sc.config } : {}),
        aiTerminal: { sessions: new Map([[sid, sc.session]]) },
      })

      const r = await h.handle({ event: 'notification', sessionId: sid, todoId: 't1' })

      expect(r.action, `${sc.name}: action`).toBe('skipped')
      expect(r.reason, `${sc.name}: reason`).toBe('notification_im_disabled')
      expect(b.broadcastText, `${sc.name}: broadcastText`).not.toHaveBeenCalled()
    }
  })

  it('SessionEnd ignores cooldown (final state)', async () => {
    await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1' })
    expect(r.action).toBe('sent')
  })

  it('restores a persisted Telegram route before sending a Stop hook', async () => {
    const sessionId = 'ai-1778306858264-mgad'
    const telegramRoute = {
      targetUserId: '-1003908174749',
      threadId: 526,
      topicName: '#td13 你好',
      channel: 'telegram',
    }
    const todo = db.createTodo({
      title: '你好',
      quadrant: 2,
      status: 'ai_running',
      aiSessions: [{
        sessionId,
        tool: 'claude',
        status: 'running',
        telegramRoute,
      }],
    })
    bridge = makeFakeBridge({ explicitRoute: false })
    handler = createOpenClawHookHandler({ db, openclaw: bridge })

    const r = await handler.handle({
      event: 'stop',
      sessionId,
      todoId: todo.id,
      todoTitle: todo.title,
    })

    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(bridge.registerSessionRoute).toHaveBeenCalledWith(sessionId, telegramRoute)
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].route).toEqual(telegramRoute)
  })

  it('rejects a persisted Telegram route with an empty thread id', async () => {
    const sessionId = 'ai-1778306858264-bad-thread'
    const todo = db.createTodo({
      title: 'bad thread route',
      quadrant: 2,
      status: 'ai_running',
      aiSessions: [{
        sessionId,
        tool: 'claude',
        status: 'running',
        telegramRoute: {
          targetUserId: '-1003908174749',
          threadId: '',
          topicName: '#bad',
          channel: 'telegram',
        },
      }],
    })
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'no_thread_id_route_missing', explicitRoute: false })
    handler = createOpenClawHookHandler({ db, openclaw: bridge })

    const r = await handler.handle({
      event: 'stop',
      sessionId,
      todoId: todo.id,
      todoTitle: todo.title,
    })

    expect(bridge.registerSessionRoute).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.action).toBe('failed')
    expect(r.reason).toBe('no_thread_id_route_missing')
    expect(bridge.sent).toHaveLength(1)
    // sent[0].route 来自 fixture default fake route（fallback target），不是 persisted route
    expect(bridge.sent[0].route).toEqual({ channel: 'openclaw-weixin', targetUserId: 'wx-default' })
  })

  it('rejects a persisted Telegram route with a conflicting channel', async () => {
    const sessionId = 'ai-1778306858264-bad-channel'
    const todo = db.createTodo({
      title: 'bad channel route',
      quadrant: 2,
      status: 'ai_running',
      aiSessions: [{
        sessionId,
        tool: 'claude',
        status: 'running',
        telegramRoute: {
          targetUserId: '-1003908174749',
          threadId: 526,
          topicName: '#bad',
          channel: 'openclaw-weixin',
        },
      }],
    })
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'no_thread_id_route_missing', explicitRoute: false })
    handler = createOpenClawHookHandler({ db, openclaw: bridge })

    const r = await handler.handle({
      event: 'stop',
      sessionId,
      todoId: todo.id,
      todoTitle: todo.title,
    })

    expect(bridge.registerSessionRoute).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.action).toBe('failed')
    expect(r.reason).toBe('no_thread_id_route_missing')
    expect(bridge.sent).toHaveLength(1)
    // sent[0].route 来自 fixture default fake route（fallback target），不是 persisted route
    expect(bridge.sent[0].route).toEqual({ channel: 'openclaw-weixin', targetUserId: 'wx-default' })
  })

  it('returns failed when bridge returns not ok', async () => {
    bridge = makeFakeBridge({ sendOk: false, sendReason: 'rate_limited' })
    handler = createOpenClawHookHandler({ db, openclaw: bridge })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1' })
    expect(r.ok).toBe(false)
    expect(r.action).toBe('failed')
    expect(r.reason).toBe('rate_limited')
  })

  it('returns failed for missing event', async () => {
    const r = await handler.handle({ sessionId: 's1' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('event_required')
  })

  // 实战回归 2：Cursor 1.7+ 每轮 stop hook 连发 3 次（13ms 内），导致 IM 收到 3 条同内容消息。
  // 5 秒短 cooldown 去重，Claude/Codex 不受影响。
  it('cursor session stop fires 3x → 2nd/3rd 被 cooldown 吞，只发 1 条', async () => {
    const sessionId = 'sid-cursor-burst'
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 7 } })
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      aiTerminal: { sessions: new Map([[sessionId, { tool: 'cursor', recentOutput: 'reply', outputHistory: [] }]]) },
    })

    const r1 = await handler.handle({ event: 'stop', sessionId, todoId: 't1' })
    const r2 = await handler.handle({ event: 'stop', sessionId, todoId: 't1' })
    const r3 = await handler.handle({ event: 'stop', sessionId, todoId: 't1' })

    expect(r1.action).toBe('sent')
    expect(r2.action).toBe('skipped')
    expect(r2.reason).toBe('cursor_stop_dedup')
    expect(r3.action).toBe('skipped')
    expect(r3.reason).toBe('cursor_stop_dedup')
    expect(bridge.broadcastText).toHaveBeenCalledTimes(1)
  })

  it('claude session 3 连发 stop 不被 cursor cooldown 影响（cooldown 只对 cursor）', async () => {
    const sessionId = 'sid-claude-three'
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 7 } })
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      aiTerminal: { sessions: new Map([[sessionId, { tool: 'claude', recentOutput: 'reply', outputHistory: [] }]]) },
    })

    const r1 = await handler.handle({ event: 'stop', sessionId, todoId: 't1' })
    const r2 = await handler.handle({ event: 'stop', sessionId, todoId: 't1' })
    const r3 = await handler.handle({ event: 'stop', sessionId, todoId: 't1' })

    expect(r1.action).toBe('sent')
    expect(r2.action).toBe('sent')
    expect(r3.action).toBe('sent')
    expect(bridge.broadcastText).toHaveBeenCalledTimes(3)
  })

  // ─── Claude PTY-detector 兜底（修复 auto 模式不 fire Notification 时状态/IM 都没反应）
  it('source=claude,path=detector: 翻 pending_confirm 且推 IM 权限按钮', async () => {
    const sessionId = 'ai-claude-pty'
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 9 } })
    const markPendingConfirm = vi.fn()
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { notificationCooldownMs: 0 } }),
      aiTerminal: {
        sessions: new Map([[sessionId, {
          todoId: 't1',
          permissionMode: 'default',   // 非 bypass → 适合接 IM 推送
          recentOutput: '',
          outputHistory: [],
        }]]),
        markPendingConfirm,
      },
    })

    const r = await handler.handle({
      source: 'claude',
      path: 'detector',
      event: 'Notification',
      sessionId,
      promptText: 'Do you want to proceed?\n1. Yes\n2. No',
    })

    expect(markPendingConfirm).toHaveBeenCalledWith(sessionId, expect.objectContaining({ source: 'claude-pty-detector' }))
    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(bridge.broadcastText).toHaveBeenCalled()
    const sent = bridge.broadcastText.mock.calls[0][0]
    expect(sent.message).toContain('Do you want to proceed')
    expect(sent.replyMarkup).toBeTruthy()   // Enter/Esc 按钮
  })

  // 实战回归：主人启 session 时选 bypass，然后在 Claude TUI 内用 /permission-mode
  // 切到 default。AgentQuad 没法感知 TUI 内部模式改动，session.permissionMode
  // 仍然记 'bypass'。但 detector 实际 fire → 证明 Claude TUI 在弹真权限框
  // → IM 必须推（detector 三层守卫已经证伪了"假阳性"），否则主人在 UI 看见
  // 卡片但飞书/Telegram 一片寂静（用户报回归）。
  it('source=claude,path=detector: bypass session 也照样推 IM（detector 实际 fire 已是铁证）', async () => {
    const sessionId = 'ai-claude-pty-bypass'
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 9 } })
    const markPendingConfirm = vi.fn()
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { notificationCooldownMs: 0 } }),
      aiTerminal: {
        sessions: new Map([[sessionId, {
          todoId: 't1',
          permissionMode: 'bypass',
          recentOutput: '',
          outputHistory: [],
        }]]),
        markPendingConfirm,
      },
    })

    const r = await handler.handle({
      source: 'claude',
      path: 'detector',
      event: 'Notification',
      sessionId,
      promptText: 'Do you want to proceed?\n1. Yes\n2. No',
    })

    expect(markPendingConfirm).toHaveBeenCalled()
    expect(r.action).toBe('sent')
    expect(bridge.broadcastText).toHaveBeenCalled()
    const sent = bridge.broadcastText.mock.calls[0][0]
    expect(sent.replyMarkup).toBeTruthy()
  })

  it('source=claude,path=detector: suppressPermissionNotifications=true 时仍然不推（主人显式关掉了）', async () => {
    const sessionId = 'ai-claude-pty-suppressed'
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 9 } })
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({
        telegram: {
          suppressPermissionNotifications: true,
          notificationCooldownMs: 0,
        },
      }),
      aiTerminal: {
        sessions: new Map([[sessionId, {
          todoId: 't1',
          permissionMode: 'default',
          recentOutput: '',
          outputHistory: [],
        }]]),
        markPendingConfirm: vi.fn(),
      },
    })

    const r = await handler.handle({
      source: 'claude',
      path: 'detector',
      event: 'Notification',
      sessionId,
      promptText: 'Do you want to proceed?',
    })

    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('im_push_not_eligible')
    expect(bridge.broadcastText).not.toHaveBeenCalled()
  })

  it('source=claude,path=detector: 自身 cooldown 防短时间内多次推 IM（TUI 重绘场景）', async () => {
    const sessionId = 'ai-claude-pty-cooldown'
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 9 } })
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { notificationCooldownMs: 60_000 } }),
      aiTerminal: {
        sessions: new Map([[sessionId, {
          todoId: 't1',
          permissionMode: 'default',
          recentOutput: '',
          outputHistory: [],
        }]]),
        markPendingConfirm: vi.fn(),
      },
    })

    // Notification 不再写 cooldown / 不再推 IM
    const noop = await handler.handle({ event: 'notification', sessionId, todoId: 't1' })
    expect(noop.action).toBe('skipped')
    expect(noop.reason).toBe('notification_im_disabled')
    expect(bridge.broadcastText).not.toHaveBeenCalled()

    // 第一次 detector 命中 → 推 IM + 写 cooldown
    const first = await handler.handle({
      source: 'claude', path: 'detector', event: 'Notification',
      sessionId, promptText: 'Do you want to proceed?',
    })
    expect(first.action).toBe('sent')
    expect(bridge.broadcastText).toHaveBeenCalledTimes(1)

    // 紧接着 detector 又命中（TUI 重绘）—— cooldown 应拦掉
    const second = await handler.handle({
      source: 'claude', path: 'detector', event: 'Notification',
      sessionId, promptText: 'Do you want to proceed?',
    })
    expect(second.action).toBe('skipped')
    expect(second.reason).toBe('notification_cooldown')
    expect(bridge.broadcastText).toHaveBeenCalledTimes(1)
  })

  // 实战回归：用户在 telegram-绑定的任务里把权限模式从 bypass 切到 default
  // → spawnSession(skipTelegram=true) 让 wizard 不重新建 topic
  // → bridge in-memory 路由对新 sessionId 是空的
  // → 但 DB 里的 aiSessions[0].telegramRoute 已经被 spawnSession 的 route-preserve 继承过来
  // detector 进来时如果不先 restorePersistedRoute，就会立刻被 isPermissionReminderEligible 拒掉
  // → IM 永远收不到权限卡片（前端仍能看见 "AI 等待授权"）。
  it('source=claude,path=detector: bridge 无 route 但 DB 有 → 先 restorePersistedRoute 再推 IM', async () => {
    const sessionId = 'ai-claude-resume-restore'
    // bridge 启动时无任何 route（显式 disable fixture default）；后续 registerSessionRoute 会从 DB 拿
    bridge = makeFakeBridge({ route: null })
    const todo = db.createTodo({ title: 'resume', quadrant: 1 })
    const todoId = todo.id
    db.updateTodo(todoId, {
      aiSessions: [{
        sessionId,
        tool: 'claude',
        nativeSessionId: 'native-resume',
        status: 'running',
        startedAt: 1,
        completedAt: null,
        prompt: 'p',
        telegramRoute: {
          channel: 'telegram',
          targetUserId: '-1001',
          threadId: 1234,
          topicName: '#t1',
        },
      }],
    })
    const markPendingConfirm = vi.fn()
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      getConfig: () => ({ telegram: { notificationCooldownMs: 0 } }),
      aiTerminal: {
        sessions: new Map([[sessionId, {
          todoId,
          permissionMode: 'default',
          recentOutput: '',
          outputHistory: [],
        }]]),
        markPendingConfirm,
      },
    })

    const r = await handler.handle({
      source: 'claude',
      path: 'detector',
      event: 'Notification',
      sessionId,
      promptText: 'Do you want to proceed?\n1. Yes\n2. No',
    })

    expect(bridge.registerSessionRoute).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      channel: 'telegram',
      threadId: 1234,
    }))
    expect(r.ok).toBe(true)
    expect(r.action).toBe('sent')
    expect(bridge.broadcastText).toHaveBeenCalled()
  })

  it('source=claude,path=detector: session_gone 安全返回（不崩、不调 bridge）', async () => {
    bridge = makeFakeBridge()
    handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      aiTerminal: { sessions: new Map(), markPendingConfirm: vi.fn() },
    })
    const r = await handler.handle({
      source: 'claude',
      path: 'detector',
      event: 'Notification',
      sessionId: 'gone',
      promptText: 'whatever',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('session_gone')
    expect(bridge.broadcastText).not.toHaveBeenCalled()
  })
})

describe('openclaw-hook router', () => {
  let app, db, bridge, handler

  beforeEach(() => {
    db = openDb(':memory:')
    // 同 handler describe：默认带一个 non-interactive route 让主路径继续跑
    bridge = makeFakeBridge({ route: { channel: 'openclaw-weixin', targetUserId: 'wx-default' } })
    handler = createOpenClawHookHandler({ db, openclaw: bridge })
    app = express()
    app.use(express.json())
    app.use('/api/openclaw/hook', createOpenClawHookRouter({ hookHandler: handler }))
  })

  it('400 when event missing', async () => {
    const supertest = (await import('supertest')).default
    const res = await supertest(app).post('/api/openclaw/hook').send({ sessionId: 's1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('event_required')
  })

  it('200 + sent for valid stop', async () => {
    const supertest = (await import('supertest')).default
    const res = await supertest(app).post('/api/openclaw/hook').send({
      event: 'stop',
      sessionId: 's1',
      todoId: 't1',
      todoTitle: 'Task A',
    })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.action).toBe('sent')
  })

  it('200 + sent for repeat stop (cooldown removed for multi-turn)', async () => {
    const supertest = (await import('supertest')).default
    await supertest(app).post('/api/openclaw/hook').send({ event: 'stop', sessionId: 's1' })
    const r = await supertest(app).post('/api/openclaw/hook').send({ event: 'stop', sessionId: 's1' })
    expect(r.body.action).toBe('sent')
  })
})

// ─── token usage footer 集成 ──────────────────────────────────────────────
//
// 这一组测试串通：jsonl 文件 → claude-transcript → usage-footer → openclaw-hook，
// 验证 footer 在 stop / session-end 时被附加到推送 message 末尾，并尊重 config 开关。
describe('openclaw-hook usage footer integration', () => {
  let tmp, jsonlPath, db, bridge

  function mkJsonl({ withAssistant = true, multipleAssistants = false, model = 'claude-sonnet-4-20260101' } = {}) {
    const lines = []
    // user 消息（assistant ts 必须在它之后才会被 readLatestAssistantTurnFresh 当 fresh）
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: '2026-05-01T10:00:00.000Z',
      message: { role: 'user', content: '帮我加注释' },
    }))
    if (withAssistant) {
      // 第一条 assistant（如果 multipleAssistants，下面还会再加一条更新的）
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-01T10:00:30.000Z',
        message: {
          role: 'assistant',
          model,
          content: [{ type: 'text', text: '已加上注释' }],
          usage: { input_tokens: 1234, output_tokens: 350, cache_read_input_tokens: 800, cache_creation_input_tokens: 200 },
        },
      }))
    }
    if (multipleAssistants) {
      lines.push(JSON.stringify({
        type: 'assistant',
        timestamp: '2026-05-01T10:01:00.000Z',
        message: {
          role: 'assistant',
          model,
          content: [{ type: 'text', text: '又改了一行' }],
          usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }))
    }
    writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8')
  }

  function mkHandler({ telegram = {}, pricing = {} } = {}) {
    return createOpenClawHookHandler({
      db, openclaw: bridge,
      cooldownMs: 0,
      // aiTerminal.sessions 提供 sessionId → nativeSessionId 映射
      aiTerminal: {
        sessions: new Map([['s1', { nativeSessionId: 'native-uuid-1', recentOutput: '', outputHistory: [] }]]),
      },
      // pty.findClaudeSession 把 nativeId 翻译成 jsonl 路径
      pty: { findClaudeSession: (nativeId) => nativeId === 'native-uuid-1' ? { filePath: jsonlPath } : null },
      // 合并 DEFAULT_PRICING 保证 default/models/cnyRate 必填字段始终存在 —— 真实运行时
      // normalizeConfig 也会填这些字段，测试这里手动模拟。
      getConfig: () => ({ telegram: { ...telegram }, pricing: { ...DEFAULT_PRICING, ...pricing } }),
      logger: { warn() {}, info() {} },
    })
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-hook-usage-'))
    jsonlPath = join(tmp, 'native-uuid-1.jsonl')
    db = openDb(':memory:')
    // 同 handler describe：默认带一个 non-interactive route 让主路径继续跑
    bridge = makeFakeBridge({ route: { channel: 'openclaw-weixin', targetUserId: 'wx-default' } })
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  it('default config: NO footer (showInPush opt-in, default false)', async () => {
    mkJsonl({ multipleAssistants: true })
    const handler = mkHandler()
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('又改了一行')      // 最新 assistant 内容
    expect(msg).not.toContain('💸')          // 默认不显示 footer
    expect(msg).not.toContain('turn:')
  })

  it('pricing.showInPush=true → footer with both turn + session lines', async () => {
    mkJsonl({ multipleAssistants: true })   // 2 assistant turns
    const handler = mkHandler({ pricing: { showInPush: true } })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('又改了一行')
    expect(msg).toContain('💸')              // footer divider
    expect(msg).toContain('turn:')
    expect(msg).toContain('session:')
    expect(msg).toContain('2 turns')
    expect(msg).toContain('$')               // USD
    expect(msg).toContain('¥')               // CNY 默认开
  })

  it('pricing.showInPush=true & showCnyInPush=false → footer present but no ¥', async () => {
    mkJsonl()
    const handler = mkHandler({ pricing: { showInPush: true, showCnyInPush: false } })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('💸')
    expect(msg).toContain('$')
    expect(msg).not.toContain('¥')
  })

  it('session-end with showInPush=true: also appends footer', async () => {
    mkJsonl({ multipleAssistants: true })
    const handler = mkHandler({ pricing: { showInPush: true } })
    const r = await handler.handle({ event: 'session-end', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('💸')
    expect(msg).toContain('session:')
  })

  it('notification with showInPush=true: 不推 IM（Notification 已退役 → footer 无关紧要）', async () => {
    mkJsonl()
    const handler = mkHandler({
      telegram: {},
      pricing: { showInPush: true },
    })
    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1', todoTitle: 'A', hookPayload: { message: 'idle' } })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_im_disabled')
    expect(bridge.sent).toHaveLength(0)
  })

  it('stop event can read native Terminal transcript from hook payload path without aiTerminal session', async () => {
    mkJsonl({ multipleAssistants: true })
    const handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      cooldownMs: 0,
      pty: { findClaudeSession: () => null },
      getConfig: () => ({ telegram: {}, pricing: { ...DEFAULT_PRICING, showInPush: true } }),
      logger: { warn() {}, info() {} },
    })
    const r = await handler.handle({
      event: 'stop',
      sessionId: 'external-local-terminal',
      todoId: 't1',
      todoTitle: 'A',
      hookPayload: {
        session_id: 'native-uuid-1',
        transcript_path: jsonlPath,
        last_assistant_message: 'hook fallback text',
      },
    })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('又改了一行')
    expect(msg).toContain('💸')
  })

  it('stop event ignores hook transcript path when it does not match hook session id', async () => {
    mkJsonl({ multipleAssistants: true })
    const handler = createOpenClawHookHandler({
      db, openclaw: bridge,
      cooldownMs: 0,
      pty: { findClaudeSession: () => null },
      getConfig: () => ({ telegram: {}, pricing: { ...DEFAULT_PRICING, showInPush: true } }),
      logger: { warn() {}, info() {} },
    })
    const r = await handler.handle({
      event: 'stop',
      sessionId: 'external-local-terminal',
      todoId: 't1',
      todoTitle: 'A',
      hookPayload: {
        session_id: 'different-native-id',
        transcript_path: jsonlPath,
      },
    })
    expect(r.action).toBe('sent')
    expect(bridge.sent[0].message).not.toContain('又改了一行')
    expect(bridge.sent[0].message).not.toContain('💸')
  })

  it('jsonl missing: silently skips footer, message still sent', async () => {
    // 不调 mkJsonl → jsonlPath 文件不存在
    // 即便 showInPush=true，jsonl 缺失也应该没 footer（验证错误兜底而非配置默认）
    const handler = mkHandler({ pricing: { showInPush: true } })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    // PTY snippet 也空 → message 走 fallback；关键是不抛异常
    expect(msg).not.toContain('💸')
  })

  it('opus model uses correct pricing (5x sonnet on input)', async () => {
    mkJsonl({ model: 'claude-opus-4-20260101' })
    const handler = mkHandler({ pricing: { showInPush: true, showCnyInPush: false } })
    const r = await handler.handle({ event: 'stop', sessionId: 's1', todoId: 't1', todoTitle: 'A' })
    expect(r.action).toBe('sent')
    const msg = bridge.sent[0].message
    expect(msg).toContain('💸')
    // opus input $15/M：单 turn input=1234 → cost > sonnet 5x，但具体值不强测，只要 footer 出现
    expect(msg).toMatch(/turn:\s+in 1\.2k/)
  })
})

describe('openclaw-hook handler — reactionTracker integration', () => {
  let db, bridge

  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('on stop with telegram route, clears reactions for sessionId', async () => {
    const reactionTracker = { clearReactionsForSession: vi.fn(async () => ({ ok: true, removed: 1 })) }
    bridge = makeFakeBridge({
      route: { channel: 'telegram', targetUserId: '-100', threadId: 5, topicName: 't' },
    })
    bridge.registerSessionRoute('sid-tg', { channel: 'telegram', targetUserId: '-100', threadId: 5, topicName: 't' })

    const handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      reactionTracker,
      cooldownMs: 0,
    })
    await handler.handle({ event: 'stop', sessionId: 'sid-tg', cleanContent: '搞完了' })
    await new Promise((r) => setImmediate(r))
    expect(reactionTracker.clearReactionsForSession).toHaveBeenCalledWith('sid-tg')
  })

  it('on stop with lark route, does NOT call telegram reactionTracker', async () => {
    const reactionTracker = { clearReactionsForSession: vi.fn(async () => ({ ok: true })) }
    const larkBot = { clearReactionsForSession: vi.fn(async () => ({ ok: true })) }
    bridge = makeFakeBridge({
      route: { channel: 'lark', chatId: 'oc-x', rootMessageId: 'mid' },
    })
    bridge.registerSessionRoute('sid-lk', { channel: 'lark', chatId: 'oc-x', rootMessageId: 'mid' })

    const handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      reactionTracker,
      larkBot,
      cooldownMs: 0,
    })
    await handler.handle({ event: 'stop', sessionId: 'sid-lk', cleanContent: 'ok' })
    await new Promise((r) => setImmediate(r))
    expect(reactionTracker.clearReactionsForSession).not.toHaveBeenCalled()
    expect(larkBot.clearReactionsForSession).toHaveBeenCalledWith('sid-lk')
  })

  it('on session-end with telegram route, also clears reactions (cleanup safety net)', async () => {
    const reactionTracker = { clearReactionsForSession: vi.fn(async () => ({ ok: true })) }
    bridge = makeFakeBridge({
      route: { channel: 'telegram', targetUserId: '-100', threadId: 5, topicName: 't' },
    })
    bridge.registerSessionRoute('sid-tg2', { channel: 'telegram', targetUserId: '-100', threadId: 5, topicName: 't' })

    const handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      reactionTracker,
      cooldownMs: 0,
    })
    await handler.handle({ event: 'session-end', sessionId: 'sid-tg2', cleanContent: '收工' })
    await new Promise((r) => setImmediate(r))
    expect(reactionTracker.clearReactionsForSession).toHaveBeenCalledWith('sid-tg2')
  })

  it('does not throw when reactionTracker is null', async () => {
    bridge = makeFakeBridge({
      route: { channel: 'telegram', targetUserId: '-100', threadId: 5, topicName: 't' },
    })
    bridge.registerSessionRoute('sid-tg3', { channel: 'telegram', targetUserId: '-100', threadId: 5, topicName: 't' })
    const handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      reactionTracker: null,
      cooldownMs: 0,
    })
    await expect(handler.handle({ event: 'stop', sessionId: 'sid-tg3', cleanContent: 'x' })).resolves.not.toThrow()
  })
})

describe('handle: user-prompt-submit event', () => {
  function makeHandler({ consumeOrigin = () => null, broadcastEcho = vi.fn().mockResolvedValue({ telegram: { ok: true }, lark: { ok: true } }) } = {}) {
    const dispatcher = { consumeOrigin: vi.fn(consumeOrigin) }
    const openclaw = {
      broadcastEcho,
      hasExplicitRoute: () => true,
      resolveRoute: () => null,
    }
    const aiTerminal = { sessions: new Map() }
    const handler = createOpenClawHookHandler({
      db: { getTodo: () => null, listTodos: () => [] },
      aiTerminal,
      openclaw,
      sessionInputDispatcher: dispatcher,
      logger: { warn() {}, info() {} },
    })
    return { handler, dispatcher, openclaw, broadcastEcho }
  }

  it('PC origin (consumeOrigin null) → broadcastEcho 不带 excludeChannel', async () => {
    const { handler, broadcastEcho } = makeHandler()
    await handler.handle({
      source: 'claude',
      event: 'user-prompt-submit',
      sessionId: 'sid-1',
      hookPayload: { user_prompt: 'hello from PC' },
    })
    expect(broadcastEcho).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      message: '👤 hello from PC',
      excludeChannel: null,
    })
  })

  it('Telegram origin (consumeOrigin returns telegram) → excludeChannel=telegram', async () => {
    const { handler, broadcastEcho } = makeHandler({ consumeOrigin: () => 'telegram' })
    await handler.handle({
      source: 'claude',
      event: 'user-prompt-submit',
      sessionId: 'sid-1',
      hookPayload: { user_prompt: 'from tg' },
    })
    expect(broadcastEcho).toHaveBeenCalledWith({
      sessionId: 'sid-1',
      message: '👤 from tg',
      excludeChannel: 'telegram',
    })
  })

  it('长 prompt > 2000 字符 → 截断 + 末尾标注总字数', async () => {
    const { handler, broadcastEcho } = makeHandler()
    const long = 'x'.repeat(2500)
    await handler.handle({
      source: 'claude',
      event: 'user-prompt-submit',
      sessionId: 'sid-1',
      hookPayload: { user_prompt: long },
    })
    const sent = broadcastEcho.mock.calls[0][0].message
    expect(sent.startsWith('👤 ')).toBe(true)
    expect(sent.length).toBeLessThanOrEqual(2 + 2000 + 32) // emoji + truncated body + suffix
    expect(sent).toContain('[共 2500 字]')
  })

  it('空 prompt → 不调用 broadcastEcho', async () => {
    const { handler, broadcastEcho } = makeHandler()
    await handler.handle({
      source: 'claude',
      event: 'user-prompt-submit',
      sessionId: 'sid-1',
      hookPayload: { user_prompt: '   ' },
    })
    expect(broadcastEcho).not.toHaveBeenCalled()
  })

  it('hookPayload 用 fallback 字段 prompt（Codex 风格）', async () => {
    const { handler, broadcastEcho } = makeHandler()
    await handler.handle({
      source: 'claude',
      event: 'user-prompt-submit',
      sessionId: 'sid-1',
      hookPayload: { prompt: 'from codex' },
    })
    expect(broadcastEcho).toHaveBeenCalledWith(
      expect.objectContaining({ message: '👤 from codex' }),
    )
  })

  it('没 sessionId → 静默 skip', async () => {
    const { handler, broadcastEcho } = makeHandler()
    const r = await handler.handle({
      source: 'claude',
      event: 'user-prompt-submit',
      sessionId: null,
      hookPayload: { user_prompt: 'x' },
    })
    expect(broadcastEcho).not.toHaveBeenCalled()
    expect(r?.ok).toBe(true) // 不报错
  })
})
