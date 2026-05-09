# Telegram Emoji Reaction 状态指示 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Telegram 用户触发消息上加 ✍ reaction 表示 "AI 在干活"，Stop hook 触发时清除；topic 标题前缀只保留终态 ✅/❌/⏹。

**Architecture:** 新增独立模块 `src/telegram-reaction-tracker.js` 维护 `sessionId → [{chatId,messageId}]`；`telegram-bot.js dispatch` 在 wizard 返回 sessionId 后通知 tracker；`openclaw-hook.js` 在 Stop / session-end 触发清理；`telegram-loading-status.js` 拆掉 running/idle 路径，仅保留终态前缀；`server.js` 用 holder 模式注入。

**Tech Stack:** Node.js (ESM), vitest, Telegram Bot API 7.0+ (`setMessageReaction`).

**Spec:** `docs/superpowers/specs/2026-05-09-telegram-emoji-reaction-design.md`

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/telegram-reaction-tracker.js` | 新建 | 工厂函数 `createReactionTracker`：维护 sessionId → [{chatId,messageId}]，提供 noteUserMessage / clearReactionsForSession |
| `test/telegram-reaction-tracker.test.js` | 新建 | tracker 单元测试 |
| `src/telegram-bot.js` | 修改 | `createTelegramBot` 增加 `reactionTracker` 入参；`dispatch` 在 wizard 返回 sessionId 后调用 `noteUserMessage` |
| `test/telegram-bot.test.js` | 修改 | 加 dispatch + reactionTracker 集成断言 |
| `src/telegram-loading-status.js` | 修改 | 删 running rename + markIdle/markRunning 实现，仅留终态前缀 |
| `test/telegram-loading-status.test.js` | 修改 | 删/改 running/idle 用例，断言 markIdle/markRunning/start 不再调 editForumTopic |
| `src/openclaw-hook.js` | 修改 | `createOpenClawHookHandler` 增加 `reactionTracker` 入参；Stop/session-end 分支按 channel 路由清理 |
| `test/openclaw-hook.test.js` | 修改 | 加 telegram route + stop → reactionTracker.clearReactionsForSession 用例 |
| `src/server.js` | 修改 | 新增 `reactionTrackerHolder`，startTelegramStack 创建，stopTelegramStack 清空，unwrapHolder 加 method 名，注入 telegramBot + hookHandler |
| `src/config.js` | 修改 | `DEFAULT_TELEGRAM_CONFIG` 增加 `reactionEnabled: true`、`reactionRunningEmoji: '✍'` |
| `docs/TELEGRAM.md` | 修改 | 新增配置项条目 |

---

## Task 1: 新建 reactionTracker 骨架（noteUserMessage + clearReactionsForSession）

**Files:**
- Create: `src/telegram-reaction-tracker.js`
- Create: `test/telegram-reaction-tracker.test.js`

- [ ] **Step 1.1: 写第一组失败测试（noteUserMessage 调 setMessageReaction + 记 list）**

创建 `test/telegram-reaction-tracker.test.js`：

```js
import { describe, it, expect, vi } from 'vitest'
import { createReactionTracker } from '../src/telegram-reaction-tracker.js'

function makeBot() {
  const calls = []
  return {
    calls,
    setMessageReaction: vi.fn(async (args) => {
      calls.push(args)
      return { ok: true }
    }),
  }
}

function makeTracker({ bot = makeBot(), config = { telegram: { reactionEnabled: true, reactionRunningEmoji: '✍' } } } = {}) {
  const tracker = createReactionTracker({
    telegramBot: bot,
    getConfig: () => config,
    logger: { info() {}, warn() {} },
  })
  return { tracker, bot }
}

describe('createReactionTracker — noteUserMessage', () => {
  it('calls setMessageReaction with running emoji and records (chatId, messageId)', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    expect(bot.setMessageReaction).toHaveBeenCalledWith({ chatId: '-100', messageId: 42, emoji: '✍' })
    expect(tracker.has('sid-1')).toBe(true)
    expect(tracker.size()).toBe(1)
  })

  it('multiple noteUserMessage on same sessionId records all messages', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 43 })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 44 })
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(3)
    expect(tracker.size()).toBe(1)  // 1 个 session
  })
})
```

- [ ] **Step 1.2: 跑测试，确认失败**

Run: `npx vitest run test/telegram-reaction-tracker.test.js`
Expected: FAIL — `Cannot find module '../src/telegram-reaction-tracker.js'`

- [ ] **Step 1.3: 实现最小骨架**

创建 `src/telegram-reaction-tracker.js`：

```js
/**
 * Telegram message reaction 跟踪器：
 *   - 用户每发一条触发 PTY 的消息，加 ✍ reaction
 *   - PTY Stop hook（一轮回复完成）→ 清掉这个 session 期间所有 ✍
 *
 * 跟 lark-bot.pendingReactions 对称；Telegram 这边 setMessageReaction 是覆盖式
 * （传空数组 = 清除），不需要存 reaction_id，只记 (chatId, messageId)。
 */

const DEFAULT_RUNNING_EMOJI = '✍'

export function createReactionTracker({
  telegramBot,
  getConfig = () => ({}),
  logger = console,
} = {}) {
  if (!telegramBot) throw new Error('telegramBot_required')

  // sessionId → [{ chatId, messageId }]
  const sessions = new Map()

  function getCfg() {
    return getConfig()?.telegram || {}
  }

  function isEnabled() {
    const v = getCfg().reactionEnabled
    return v !== false   // 默认开
  }

  function runningEmoji() {
    return getCfg().reactionRunningEmoji || DEFAULT_RUNNING_EMOJI
  }

  async function noteUserMessage({ sessionId, chatId, messageId } = {}) {
    if (!sessionId || !chatId || !messageId) return
    if (!isEnabled()) return
    const list = sessions.get(sessionId) || []
    list.push({ chatId: String(chatId), messageId })
    sessions.set(sessionId, list)
    try {
      await telegramBot.setMessageReaction({ chatId, messageId, emoji: runningEmoji() })
    } catch (e) {
      logger.warn?.(`[reaction-tracker] note failed sid=${sessionId} msg=${messageId}: ${e.message}`)
    }
  }

  async function clearReactionsForSession(sessionId) {
    if (!sessionId) return { ok: true, removed: 0 }
    const list = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (!list || list.length === 0) return { ok: true, removed: 0 }
    let removed = 0
    for (const { chatId, messageId } of list) {
      try {
        await telegramBot.setMessageReaction({ chatId, messageId, emoji: null })
        removed++
      } catch (e) {
        logger.warn?.(`[reaction-tracker] clear failed sid=${sessionId} msg=${messageId}: ${e.message}`)
      }
    }
    return { ok: true, removed, total: list.length }
  }

  function has(sessionId) { return sessions.has(sessionId) }
  function size() { return sessions.size }

  return { noteUserMessage, clearReactionsForSession, has, size, __test__: { sessions } }
}
```

- [ ] **Step 1.4: 跑测试，确认通过**

Run: `npx vitest run test/telegram-reaction-tracker.test.js`
Expected: PASS — 2 passed

- [ ] **Step 1.5: 写 clearReactionsForSession 测试**

把以下 describe block 追加到 `test/telegram-reaction-tracker.test.js`：

```js
describe('createReactionTracker — clearReactionsForSession', () => {
  it('calls setMessageReaction({emoji:null}) for every recorded message and clears the session', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 43 })
    bot.setMessageReaction.mockClear()
    const r = await tracker.clearReactionsForSession('sid-1')
    expect(r).toEqual({ ok: true, removed: 2, total: 2 })
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(2)
    expect(bot.setMessageReaction).toHaveBeenNthCalledWith(1, { chatId: '-100', messageId: 42, emoji: null })
    expect(bot.setMessageReaction).toHaveBeenNthCalledWith(2, { chatId: '-100', messageId: 43, emoji: null })
    expect(tracker.has('sid-1')).toBe(false)
  })

  it('clearReactionsForSession on unknown sessionId is a no-op', async () => {
    const { tracker, bot } = makeTracker()
    const r = await tracker.clearReactionsForSession('unknown')
    expect(r).toEqual({ ok: true, removed: 0 })
    expect(bot.setMessageReaction).not.toHaveBeenCalled()
  })

  it('isolates sessions: clearing one does not affect the other', async () => {
    const { tracker, bot } = makeTracker()
    await tracker.noteUserMessage({ sessionId: 'sid-A', chatId: '-100', messageId: 1 })
    await tracker.noteUserMessage({ sessionId: 'sid-B', chatId: '-100', messageId: 2 })
    bot.setMessageReaction.mockClear()
    await tracker.clearReactionsForSession('sid-A')
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(1)
    expect(bot.setMessageReaction).toHaveBeenCalledWith({ chatId: '-100', messageId: 1, emoji: null })
    expect(tracker.has('sid-A')).toBe(false)
    expect(tracker.has('sid-B')).toBe(true)
  })
})
```

- [ ] **Step 1.6: 跑测试，确认通过（实现已经覆盖）**

Run: `npx vitest run test/telegram-reaction-tracker.test.js`
Expected: PASS — 5 passed

- [ ] **Step 1.7: Commit**

```bash
git add src/telegram-reaction-tracker.js test/telegram-reaction-tracker.test.js
git commit -m "feat(telegram): add reaction tracker (note/clear by sessionId)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: reactionTracker 边界 — 配置开关、错误吞没、自定义 emoji

**Files:**
- Modify: `test/telegram-reaction-tracker.test.js`
- Modify: `src/telegram-reaction-tracker.js` (实际不需要改，覆盖测试即可)

- [ ] **Step 2.1: 写 reactionEnabled=false 测试**

追加到 test 文件：

```js
describe('createReactionTracker — config behavior', () => {
  it('reactionEnabled=false makes noteUserMessage a no-op', async () => {
    const { tracker, bot } = makeTracker({
      config: { telegram: { reactionEnabled: false } },
    })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    expect(bot.setMessageReaction).not.toHaveBeenCalled()
    expect(tracker.has('sid-1')).toBe(false)
  })

  it('uses configured reactionRunningEmoji', async () => {
    const { tracker, bot } = makeTracker({
      config: { telegram: { reactionEnabled: true, reactionRunningEmoji: '👀' } },
    })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    expect(bot.setMessageReaction).toHaveBeenCalledWith({ chatId: '-100', messageId: 42, emoji: '👀' })
  })

  it('defaults reactionEnabled to true when key absent', async () => {
    const { tracker, bot } = makeTracker({ config: { telegram: {} } })
    await tracker.noteUserMessage({ sessionId: 'sid-1', chatId: '-100', messageId: 42 })
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2.2: 写错误吞没测试**

继续追加：

```js
describe('createReactionTracker — error handling', () => {
  it('swallows setMessageReaction error in noteUserMessage and still records', async () => {
    const warns = []
    const bot = {
      setMessageReaction: vi.fn(async () => { throw new Error('REACTION_INVALID') }),
    }
    const tracker = createReactionTracker({
      telegramBot: bot,
      getConfig: () => ({ telegram: {} }),
      logger: { info() {}, warn: (m) => warns.push(String(m)) },
    })
    await expect(tracker.noteUserMessage({ sessionId: 'sid', chatId: '-100', messageId: 42 })).resolves.not.toThrow()
    expect(tracker.has('sid')).toBe(true)
    expect(warns.some((w) => w.includes('REACTION_INVALID'))).toBe(true)
  })

  it('continues clearing remaining messages when one delete fails', async () => {
    let n = 0
    const bot = {
      setMessageReaction: vi.fn(async () => {
        n++
        if (n === 2) throw new Error('boom')
        return { ok: true }
      }),
    }
    const tracker = createReactionTracker({
      telegramBot: bot,
      getConfig: () => ({ telegram: {} }),
      logger: { info() {}, warn() {} },
    })
    await tracker.noteUserMessage({ sessionId: 'sid', chatId: '-100', messageId: 1 })
    await tracker.noteUserMessage({ sessionId: 'sid', chatId: '-100', messageId: 2 })
    await tracker.noteUserMessage({ sessionId: 'sid', chatId: '-100', messageId: 3 })
    bot.setMessageReaction.mockClear(); n = 0
    const r = await tracker.clearReactionsForSession('sid')
    // 三次清除调用都应被发出（即使第二次抛错）
    expect(bot.setMessageReaction).toHaveBeenCalledTimes(3)
    expect(r.removed).toBe(2)
    expect(r.total).toBe(3)
  })
})
```

- [ ] **Step 2.3: 跑全部 tracker 测试**

Run: `npx vitest run test/telegram-reaction-tracker.test.js`
Expected: PASS — 10 passed (累计)

- [ ] **Step 2.4: Commit**

```bash
git add test/telegram-reaction-tracker.test.js
git commit -m "test(telegram): cover reaction-tracker config + error swallow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: telegram-bot.js dispatch 接 reactionTracker

**Files:**
- Modify: `src/telegram-bot.js` (createTelegramBot 入参 + dispatch 路径)
- Modify: `test/telegram-bot.test.js` (新增集成断言)

- [ ] **Step 3.1: 写失败测试 — wizard 返回 sessionId 时 reactionTracker.noteUserMessage 被调用**

在 `test/telegram-bot.test.js` 的 `describe('telegram-bot inbound dispatch', () => {` 块内（譬如紧跟 `routes message from authorized chat to wizard with thread_id` 之后）插入：

```js
  it('forwards (sessionId, chatId, messageId) to reactionTracker.noteUserMessage when wizard returns sessionId', async () => {
    const noteCalls = []
    const reactionTracker = {
      noteUserMessage: vi.fn(async (args) => { noteCalls.push(args) }),
    }
    const fetchFn = makeFetchSeq([{
      body: { ok: true, result: [{
        update_id: 1,
        message: {
          message_id: 7777,
          chat: { id: '-100authorized' },
          text: 'do something',
          from: { id: '999' },
          message_thread_id: 88,
        },
      }] },
    }])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-100authorized'] } }),
      wizard: makeWizard(async () => ({ sessionId: 'sid-xyz' })),
      reactionTracker,
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(noteCalls).toEqual([{ sessionId: 'sid-xyz', chatId: '-100authorized', messageId: 7777 }])
  })

  it('skips reactionTracker.noteUserMessage when wizard does not return sessionId', async () => {
    const reactionTracker = { noteUserMessage: vi.fn(async () => {}) }
    const fetchFn = makeFetchSeq([{
      body: { ok: true, result: [{
        update_id: 1,
        message: { message_id: 1, chat: { id: '-100authorized' }, text: 'hi', from: { id: '999' } },
      }] },
    }])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-100authorized'] } }),
      wizard: makeWizard(async () => ({ reply: 'pong' })),
      reactionTracker,
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await bot.pollOnce()
    expect(reactionTracker.noteUserMessage).not.toHaveBeenCalled()
  })

  it('does not throw when reactionTracker is null and wizard returns sessionId', async () => {
    const fetchFn = makeFetchSeq([{
      body: { ok: true, result: [{
        update_id: 1,
        message: { message_id: 9, chat: { id: '-100authorized' }, text: 'go', from: { id: '999' } },
      }] },
    }])
    const bot = createTelegramBot({
      getConfig: () => ({ telegram: { botToken: 'X', allowedChatIds: ['-100authorized'] } }),
      wizard: makeWizard(async () => ({ sessionId: 'sid-q' })),
      reactionTracker: null,
      fetchFn, offsetFile,
      logger: { warn() {}, info() {} },
    })
    await expect(bot.pollOnce()).resolves.not.toThrow()
  })
```

- [ ] **Step 3.2: 跑测试，确认失败（reactionTracker 还没接进 dispatch）**

Run: `npx vitest run test/telegram-bot.test.js -t "reactionTracker"`
Expected: FAIL — `noteCalls` 为空

- [ ] **Step 3.3: 修改 createTelegramBot 接受 reactionTracker 入参**

编辑 `src/telegram-bot.js`，把 `createTelegramBot` 函数签名（约第 118 行）的解构对象增加 `reactionTracker = null`：

把原来的：

```js
export function createTelegramBot({
  getConfig,
  wizard,
  logger = console,
  fetchFn,
  offsetFile = DEFAULT_OFFSET_FILE,
} = {}) {
```

改为：

```js
export function createTelegramBot({
  getConfig,
  wizard,
  reactionTracker = null,
  logger = console,
  fetchFn,
  offsetFile = DEFAULT_OFFSET_FILE,
} = {}) {
```

- [ ] **Step 3.4: dispatch 中接通 reactionTracker.noteUserMessage**

定位 `src/telegram-bot.js` 中 `wizard.handleInbound(...)` 调用之后、`if (result && typeof result.reply === 'string'` 之前的位置（约第 622 行附近，在 `result = await wizard.handleInbound(...)` 之后）。在 `if (photoDownloadFailed && result?.action === 'stdin_proxy')` 那个 if 块**之前**插入：

```js
    // wizard 返回 sessionId 表示这条消息触发了一轮 PTY 处理 —— 通知 reactionTracker 加 ✍ reaction
    // 并记录 (chatId, messageId)，等 Stop hook 触发 clearReactionsForSession 时统一删
    if (result?.sessionId && reactionTracker?.noteUserMessage) {
      reactionTracker.noteUserMessage({
        sessionId: result.sessionId,
        chatId,
        messageId: msg.message_id,
      }).catch((e) => logger.warn?.(`[telegram-bot] reactionTracker.noteUserMessage failed: ${e.message}`))
    }
```

- [ ] **Step 3.5: 跑测试，确认通过**

Run: `npx vitest run test/telegram-bot.test.js`
Expected: PASS — 全部通过（含 3 个新增）

- [ ] **Step 3.6: Commit**

```bash
git add src/telegram-bot.js test/telegram-bot.test.js
git commit -m "feat(telegram): wire dispatch → reactionTracker.noteUserMessage

When wizard returns a sessionId, hand the (chatId, messageId) to the
reaction tracker so it can add ✍ on the user's trigger message.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: telegram-loading-status.js — 拆掉 running/idle 路径，仅留终态

**Files:**
- Modify: `src/telegram-loading-status.js`
- Modify: `test/telegram-loading-status.test.js`

- [ ] **Step 4.1: 改测试 — 改写 running/idle 用例为 "应该不再触发 editForumTopic"**

打开 `test/telegram-loading-status.test.js`。

**全文替换** describe `'createLoadingTracker — title rename only'` 块内的内容为：

```js
describe('createLoadingTracker — terminal-only title rename', () => {
  it('start does NOT rename topic to "🔄 <name>" anymore (reaction-tracker handles running)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)
    expect(h.tracker.has('sess-x')).toBe(true)   // session 仍记录（stop 时要用 originalTopicName）
  })

  it('renames topic to "✅ <name>" on done', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(1)
    expect(h.editedTopics[0].name).toBe('✅ #t42 修复 login bug')
    expect(h.tracker.has('sess-x')).toBe(false)
  })

  it('renames to "❌ <name>" on failed', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'failed' })
    expect(h.editedTopics[0].name).toBe('❌ #t42 修复 login bug')
  })

  it('renames to "⏹ <name>" on stopped', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'stopped' })
    expect(h.editedTopics[0].name).toBe('⏹ #t42 修复 login bug')
  })

  it('skips when no telegram route', async () => {
    const h = makeHarness({ route: null })
    await h.tracker.start({ sessionId: 'no-route' })
    expect(h.editedTopics).toHaveLength(0)
    expect(h.tracker.size()).toBe(0)
  })

  it('skips when route has no topicName', async () => {
    const h = makeHarness({ route: { targetUserId: '-1', threadId: 1, topicName: null } })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('does not throw when telegramBot lacks editForumTopic', async () => {
    const tracker = createLoadingTracker({
      telegramBot: {},
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: { info() {}, warn() {} },
    })
    await expect(tracker.start({ sessionId: 'sess-x' })).resolves.not.toThrow()
    await expect(tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })).resolves.not.toThrow()
  })

  it('idempotent: starting same sessionId twice is no-op', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)   // start 不再 rename，所以应保持 0
  })

  it('stop on unknown sessionId is no-op', async () => {
    const h = makeHarness()
    await h.tracker.stop({ sessionId: 'unknown', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markIdle is a no-op (reaction-tracker handles idle)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.markIdle('sess-x')
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markRunning is a no-op (reaction-tracker handles running)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.markRunning('sess-x')
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markIdle / markRunning on unknown sessionId is also no-op', async () => {
    const h = makeHarness()
    await h.tracker.markIdle('unknown')
    await h.tracker.markRunning('unknown')
    expect(h.editedTopics).toHaveLength(0)
  })
})
```

**全文替换** describe `'createLoadingTracker — rate limit defenses'` 块内容为（删掉 30s 节流相关用例 + 简化 backoff 测试，因为 running 路径已不存在）：

```js
describe('createLoadingTracker — terminal rename rate limit', () => {
  it('terminal rename ignores backoff state from earlier 429 (✅/❌/⏹ must show)', async () => {
    let callCount = 0
    const editsAfterBackoff = []
    const telegramBot = {
      editForumTopic: vi.fn(async (args) => {
        callCount++
        if (callCount === 1) {
          const err = new Error('429')
          err.description = 'Too Many Requests: retry after 30'
          throw err
        }
        editsAfterBackoff.push(args)
        return { ok: true }
      }),
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: {
        resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 'mytopic' }),
      },
      logger: { info() {}, warn() {} },
    })
    // 第一次 stop 触发 429 backoff
    await tracker.start({ sessionId: 'sess-x' })
    await tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(callCount).toBe(1)
    // 第二次 stop 仍硬上（终态绕过任何 backoff）
    await tracker.start({ sessionId: 'sess-y' })
    await tracker.stop({ sessionId: 'sess-y', finalStatus: 'done' })
    expect(callCount).toBe(2)
    expect(editsAfterBackoff[0].name).toBe('✅ mytopic')
  })

  it('treats "TOPIC_NOT_MODIFIED" as success (no warn)', async () => {
    let warned = false
    const telegramBot = {
      editForumTopic: async () => {
        const err = new Error('400')
        err.description = 'Bad Request: TOPIC_NOT_MODIFIED'
        throw err
      },
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: { info() {}, warn() { warned = true } },
    })
    await tracker.start({ sessionId: 'sess-x' })
    await expect(tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })).resolves.not.toThrow()
    expect(warned).toBe(false)
  })
})
```

- [ ] **Step 4.2: 跑测试，确认大部分失败（实现还没改）**

Run: `npx vitest run test/telegram-loading-status.test.js`
Expected: FAIL — "start does NOT rename..."、"markIdle is a no-op"、"markRunning is a no-op" 等用例 fail，因为现有实现还在 rename。

- [ ] **Step 4.3: 改 src/telegram-loading-status.js — 拆掉 running/idle 路径**

打开 `src/telegram-loading-status.js`。**整文件替换**为：

```js
/**
 * 只做一件事：在 PTY session **终态** 时改 telegram topic 标题前缀。
 *
 *   done     → ✅ <name>      （PTY exit 0）
 *   failed   → ❌ <name>      （PTY exit ≠ 0）
 *   stopped  → ⏹ <name>      （用户主动 stop）
 *
 * running / idle 状态由 src/telegram-reaction-tracker.js 通过给用户消息加/删
 * ✍ reaction 表达 —— 那条路径粒度更细、节流压力更小，留这里只管终态。
 *
 * 限速防御：
 *   - 全局 backoff（429）保留，但终态硬上，不受 backoff 影响 —— ✅/❌/⏹
 *     是用户最在意的状态，必须显示。
 *
 * 为了向后兼容，markIdle / markRunning / start 接口保留但 running/idle 改为 no-op。
 */

const TITLE_PREFIX_BY_PHASE = {
  done:    '✅ ',
  failed:  '❌ ',
  stopped: '⏹ ',
}

const TERMINAL_PHASES = new Set(['done', 'failed', 'stopped'])

/**
 * @param {object} opts
 * @param opts.telegramBot { editForumTopic({chatId,threadId,name}) }
 * @param opts.openclaw    { resolveRoute(sessionId) → {targetUserId, threadId, topicName} | null }
 * @param opts.logger
 * @param opts.now         可注入时钟（测试用）
 */
export function createLoadingTracker({
  telegramBot,
  openclaw,
  logger = console,
  now = () => Date.now(),
  getConfig = null,
} = {}) {
  if (!telegramBot) throw new Error('telegramBot_required')

  // sessionId → { chatId, threadId, originalTopicName }
  const sessions = new Map()

  // 全局 backoff（429 触发 → 仅记录，但终态 rename 仍硬上）
  let globalBackoffUntil = 0
  function setBackoff(retryAfterSec) {
    const ms = Math.max(1, Number(retryAfterSec) || 1) * 1000
    globalBackoffUntil = Math.max(globalBackoffUntil, now() + ms)
    logger.warn?.(`[loading-status] global backoff for ${ms}ms (telegram 429)`)
  }
  function parseRetryAfter(desc) {
    const m = String(desc || '').match(/retry after (\d+)/i)
    return m ? Number(m[1]) : 0
  }

  async function renameTerminal(state, phase) {
    if (!telegramBot.editForumTopic || !state.originalTopicName) return
    const prefix = TITLE_PREFIX_BY_PHASE[phase]
    if (!prefix) return
    const newName = (prefix + state.originalTopicName).slice(0, 128)
    try {
      await telegramBot.editForumTopic({
        chatId: state.chatId,
        threadId: state.threadId,
        name: newName,
      })
    } catch (e) {
      const desc = e?.description || e?.message || ''
      const retryAfter = parseRetryAfter(desc) || (e?.parameters?.retry_after) || 0
      if (/too many requests|429/i.test(desc) || retryAfter > 0) {
        setBackoff(retryAfter || 5)
        return
      }
      if (!/not[ _]modified/i.test(desc)) {
        logger.warn?.(`[loading-status] editForumTopic phase=${phase} failed sid=${state.sessionId}: ${desc}`)
      }
    }
  }

  /**
   * 注册 session（PTY native-session 时 server.js 调）。不再发任何 rename，
   * 只把 originalTopicName 记下来给后续 stop 用。
   * skipTitleRename 现在不影响行为（保留参数避免破坏 caller）。
   */
  async function start({ sessionId, skipTitleRename = false } = {}) {
    if (!sessionId || sessions.has(sessionId)) return
    void skipTitleRename
    const route = openclaw?.resolveRoute?.(sessionId)
    if (!route?.threadId) return
    if (!route.topicName) return
    sessions.set(sessionId, {
      sessionId,
      chatId: String(route.targetUserId),
      threadId: route.threadId,
      originalTopicName: route.topicName,
    })
  }

  // running / idle 由 reaction-tracker 处理；这两个接口保留向后兼容，但改为 no-op
  async function markIdle(_sessionId) { /* no-op */ }
  async function markRunning(_sessionId) { /* no-op */ }

  async function stop({ sessionId, finalStatus = 'done' } = {}) {
    const state = sessions.get(sessionId)
    if (!state) return
    sessions.delete(sessionId)
    if (TERMINAL_PHASES.has(finalStatus)) {
      await renameTerminal(state, finalStatus)
    }
  }

  function has(sessionId) { return sessions.has(sessionId) }
  function size() { return sessions.size }

  return { start, stop, markIdle, markRunning, has, size, __test__: { sessions } }
}
```

- [ ] **Step 4.4: 跑测试，确认通过**

Run: `npx vitest run test/telegram-loading-status.test.js`
Expected: PASS — 全部通过（13 用例：12 在 terminal-only 块 + 2 在 rate limit 块；准确数以 vitest 输出为准）

- [ ] **Step 4.5: 跑相关回归（确保 wizard / hook 调用 markRunning/markIdle 不出问题）**

Run: `npx vitest run test/openclaw-wizard.test.js test/openclaw-hook.test.js`
Expected: PASS — 仍然全部通过（markRunning/markIdle 在 wizard 测试里被调，现在是 no-op，不应抛错；wizard 测试里 `loadingTracker = { start: vi.fn() }` 这种本来就 mock 了的不受影响）

- [ ] **Step 4.6: Commit**

```bash
git add src/telegram-loading-status.js test/telegram-loading-status.test.js
git commit -m "refactor(telegram): drop title rename for running/idle, keep terminal only

Running/idle status will be expressed via message reactions
(see src/telegram-reaction-tracker.js); terminal prefix (✅/❌/⏹) stays
in loading-status. markIdle/markRunning kept as no-op for caller compat.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: openclaw-hook.js 接 reactionTracker

**Files:**
- Modify: `src/openclaw-hook.js`
- Modify: `test/openclaw-hook.test.js`

- [ ] **Step 5.1: 写失败测试 — telegram route + Stop / session-end → reactionTracker.clearReactionsForSession 被调**

在 `test/openclaw-hook.test.js` 文件末尾追加新 describe 块（在现有 `describe('openclaw-hook helpers'`、`describe('openclaw-hook handler'` 等后面）：

```js
describe('openclaw-hook handler — reactionTracker integration', () => {
  let tmp, dbPath, db
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'qt-hook-'))
    dbPath = join(tmp, 'test.db')
    db = openDb({ filename: dbPath })
  })
  afterEach(() => {
    try { db.close() } catch {}
    rmSync(tmp, { recursive: true, force: true })
  })

  it('on stop with telegram route, clears reactions for sessionId', async () => {
    const reactionTracker = { clearReactionsForSession: vi.fn(async () => ({ ok: true, removed: 1 })) }
    const bridge = makeFakeBridge({
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
    // 异步 .catch handler，等一拍让 microtask 跑
    await new Promise((r) => setImmediate(r))
    expect(reactionTracker.clearReactionsForSession).toHaveBeenCalledWith('sid-tg')
  })

  it('on stop with lark route, does NOT call telegram reactionTracker', async () => {
    const reactionTracker = { clearReactionsForSession: vi.fn(async () => ({ ok: true })) }
    const larkBot = { clearReactionsForSession: vi.fn(async () => ({ ok: true })) }
    const bridge = makeFakeBridge({
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
    const bridge = makeFakeBridge({
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
    const bridge = makeFakeBridge({
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
```

确保文件顶部 import 包含必要的 `mkdtempSync, rmSync` 和 `tmpdir, join`、`openDb` —— 现有文件已有；如缺补齐。

- [ ] **Step 5.2: 跑测试，确认失败**

Run: `npx vitest run test/openclaw-hook.test.js -t "reactionTracker integration"`
Expected: FAIL — `reactionTracker.clearReactionsForSession` 没被调用

- [ ] **Step 5.3: 改 createOpenClawHookHandler 接受 reactionTracker，并在 Stop / session-end 路由清理**

打开 `src/openclaw-hook.js`，定位 `createOpenClawHookHandler` 函数签名（约第 223 行）：

```js
export function createOpenClawHookHandler({
  db, openclaw, aiTerminal = null,
  pty = null, telegramBot = null, larkBot = null, loadingTracker = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  getConfig = null,
  logger = console,
} = {}) {
```

改为：

```js
export function createOpenClawHookHandler({
  db, openclaw, aiTerminal = null,
  pty = null, telegramBot = null, larkBot = null, loadingTracker = null,
  reactionTracker = null,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  getConfig = null,
  logger = console,
} = {}) {
```

然后定位 lark 清 reaction 的现有分支（约第 640-645 行）：

```js
      // Stop / session-end → 清掉 lark "在思考" reaction（如果是 lark route）
      if ((evt === 'stop' || evt === 'session-end') && sessionId && larkBot?.clearReactionsForSession) {
        const route = openclaw.resolveRoute?.(sessionId)
        if (route?.channel === 'lark') {
          larkBot.clearReactionsForSession(sessionId).catch((e) => logger.warn?.(`[openclaw-hook] clearReactionsForSession failed: ${e.message}`))
        }
      }
```

紧接其后追加 telegram 分支：

```js
      // Stop / session-end → 清掉 telegram "✍" reaction（如果是 telegram route）
      if ((evt === 'stop' || evt === 'session-end') && sessionId && reactionTracker?.clearReactionsForSession) {
        const route = openclaw.resolveRoute?.(sessionId)
        if (route?.channel === 'telegram') {
          reactionTracker.clearReactionsForSession(sessionId).catch((e) => logger.warn?.(`[openclaw-hook] tg clearReactionsForSession failed: ${e.message}`))
        }
      }
```

- [ ] **Step 5.4: 跑测试，确认通过**

Run: `npx vitest run test/openclaw-hook.test.js`
Expected: PASS — 全部通过

- [ ] **Step 5.5: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.test.js
git commit -m "feat(openclaw-hook): clear telegram reactions on stop/session-end

Mirrors the existing lark clearReactionsForSession branch; routes by
channel so each chat backend cleans up its own reaction artifacts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: server.js 接线 — reactionTrackerHolder + 注入

**Files:**
- Modify: `src/server.js`

(server.js 没单元测试，靠 boot smoke + 上游 task 的回归保证。)

- [ ] **Step 6.1: import reaction tracker 工厂**

打开 `src/server.js`。在文件顶部 import 区找到 `import { createLoadingTracker } from "./telegram-loading-status.js";`（约第 43 行），其下面新增：

```js
import { createReactionTracker } from "./telegram-reaction-tracker.js";
```

- [ ] **Step 6.2: 新增 holder + 启动时创建 + 停止时清空**

定位 `const loadingTrackerHolder = { current: null }`（约第 1059 行），在它下面新增：

```js
		const reactionTrackerHolder = { current: null }
```

定位 `loadingTrackerHolder.current = createLoadingTracker({...})`（约 1086 行），在 `createLoadingTracker(...)` 之后**修改 createTelegramBot 的调用**：先把上面 `bot = createTelegramBot({...})` 中的入参增加一个占位 `reactionTracker` 引用 —— 但因为 reactionTracker 需要 bot 作为依赖，存在循环依赖问题。**正确做法**：

把现有 startTelegramStack 内的顺序改为：

```js
		function startTelegramStack() {
			const cfg = loadConfig({ rootDir: configRootDir })
			const tg = cfg.telegram || {}
			if (!tg.enabled) {
				console.log('[telegram] disabled, skipping bot start')
				return
			}
			// reactionTracker holder，先建一个占位，bot 创建后再 set
			// 用 lazy ref 模式跟 wizard 一致，避免循环
			const reactionTrackerLazyRef = {
				noteUserMessage: (...args) => reactionTrackerHolder.current?.noteUserMessage?.(...args) ?? Promise.resolve(),
				clearReactionsForSession: (...args) => reactionTrackerHolder.current?.clearReactionsForSession?.(...args) ?? Promise.resolve({ ok: true, removed: 0 }),
			}
			const bot = createTelegramBot({
				getConfig: () => loadConfig({ rootDir: configRootDir }),
				wizard: {
					handleInbound: (...args) => openclawWizardLazyRef.handleInbound(...args),
					handleCallback: (...args) => openclawWizardLazyRef.handleCallback(...args),
					handleTopicEvent: (...args) => openclawWizardLazyRef.handleTopicEvent(...args),
				},
				reactionTracker: reactionTrackerLazyRef,
				logger: { warn: (...a) => console.warn(...a), info: (...a) => console.log(...a) },
			})
			telegramBotHolder.current = bot
			loadingTrackerHolder.current = createLoadingTracker({
				telegramBot: bot,
				openclaw: openclawBridge,
				logger: console,
				getConfig: () => loadConfig({ rootDir: configRootDir }),
			})
			reactionTrackerHolder.current = createReactionTracker({
				telegramBot: bot,
				getConfig: () => loadConfig({ rootDir: configRootDir }),
				logger: console,
			})
			openclawBridge.setTelegramBot(bot)
			bot.start()
			console.log(`[telegram] bot started; supergroup=${tg.supergroupId || '(unset)'} allowedChatIds=${(tg.allowedChatIds||[]).join(',')||'(empty—reject all)'}`)

			// 注册 Claude Code slash 命令到 supergroup（per-chat scope，不影响 bot 在别处的菜单）
			// idempotent；失败不阻塞 boot（log warn 后继续）
			const supergroupId = tg.defaultSupergroupId
				|| (Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds[0] : null)
			if (supergroupId) {
				try {
					const { commands, skipped } = buildTelegramCommands({ projectRoot: configRootDir, logger: console })
					bot.setMyCommands({ commands, scope: 'chat', chatId: supergroupId })
						.then(() => console.log(`[telegram] registered ${commands.length} slash command(s) for supergroup ${supergroupId}${skipped.length ? ` (skipped ${skipped.length})` : ''}`))
						.catch((e) => console.warn(`[telegram] setMyCommands failed: ${e.message}`))
				} catch (e) {
					console.warn(`[telegram] build commands failed: ${e.message}`)
				}
			}
		}
```

定位 `stopTelegramStack`（约 1112 行），把 `loadingTrackerHolder.current = null` 那行下面增加：

```js
			reactionTrackerHolder.current = null
```

- [ ] **Step 6.3: unwrapHolder 加 method 名**

定位 `unwrapHolder` 中的 `asyncMethods` 集合（约 1203-1210 行），在 `'clearReactionsForSession'` 之后追加 `'noteUserMessage'`（已经有 clearReactionsForSession 了，因为 lark 也用这个名）。最终该集合应该包含：

```js
						const asyncMethods = new Set([
							'start', 'stop', 'sendMessage', 'sendDocument', 'editMessageText', 'editMessageReplyMarkup',
							'answerCallbackQuery',
							'createForumTopic', 'closeForumTopic', 'reopenForumTopic', 'editForumTopic',
							'setMessageReaction', 'setMyCommands', 'deleteMyCommands', 'getMe',
							'replyInThread', 'handleEvent', 'handleCardAction',
							'sendCard', 'replyWithCard', 'clearReactionsForSession', 'noteUserMessage',
						])
```

- [ ] **Step 6.4: 注入 reactionTracker 到 hookHandler**

定位 `const reactionTrackerProxy` —— 当前没有，新增。在 `const loadingTrackerProxy = unwrapHolder(loadingTrackerHolder, 'loading_tracker')`（约 1229 行）下面追加：

```js
		const reactionTrackerProxy = unwrapHolder(reactionTrackerHolder, 'reaction_tracker')
```

然后在 `createOpenClawHookHandler({...})` 调用（约 1231-1240 行）中，把入参增加一行 `reactionTracker: reactionTrackerProxy,`：

```js
		const openclawHookHandler = createOpenClawHookHandler({
			db,
			openclaw: openclawBridge,
			aiTerminal: ait,
			pty,
			telegramBot: telegramBotProxy,
			larkBot: larkBotProxy,                                // Stop hook → 清掉 lark "在思考" reaction
			loadingTracker: loadingTrackerProxy,                  // Stop hook → 标题切 ✅/❌/⏹
			reactionTracker: reactionTrackerProxy,                // Stop hook → 清 telegram ✍ reaction
			getConfig: () => loadConfig({ rootDir: configRootDir }),
		});
```

注意：注释 `→ 标题切 💤` 也顺手改成 `→ 标题切 ✅/❌/⏹`（因为 💤 已经废了）。

- [ ] **Step 6.5: 启动 server，手动确认无 boot 错**

Run: `node src/cli.js start --foreground` 在另一个终端，或 `npm run dev` 看启动日志（具体启动命令取决于项目脚本）。

更稳的：Run vitest 全量回归，确认没有任何路径破：

```bash
npx vitest run
```

Expected: PASS — 全部通过

- [ ] **Step 6.6: Commit**

```bash
git add src/server.js
git commit -m "feat(server): wire reactionTrackerHolder for telegram bot

Holder pattern matches loadingTracker; tracker is created with the bot
and torn down on stopTelegramStack. Bot itself receives a lazyRef so
the create order avoids the bot ↔ tracker cycle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 默认配置 + 文档

**Files:**
- Modify: `src/config.js`
- Modify: `docs/TELEGRAM.md`

- [ ] **Step 7.1: 在 DEFAULT_TELEGRAM_CONFIG 增加 reaction 字段**

打开 `src/config.js`，定位 `DEFAULT_TELEGRAM_CONFIG`（约第 76 行）。在 `minRenameIntervalMs: 30_000,` 之后追加两行：

```js
	reactionEnabled: true,              // 在用户触发消息上加 ✍ reaction 表示 AI 在干活；Stop hook 时清掉
	reactionRunningEmoji: '✍',          // 用哪个 Telegram 标准 emoji；群里若限制了 Available Reactions，改成允许列表里的（譬如 👀 / 🤔）
```

最终块为：

```js
const DEFAULT_TELEGRAM_CONFIG = {
	enabled: false,
	supergroupId: "",
	longPollTimeoutSec: 30,
	useTopics: true,
	createTopicOnTaskStart: true,
	closeTopicOnSessionEnd: true,
	topicNameTemplate: "#t{shortCode} {title}",
	topicNameDoneTemplate: "✅ {originalName}",
	allowedChatIds: [],
	allowedFromUserIds: [],
	defaultPermissionMode: "bypass",
	notificationCooldownMs: 600_000,
	suppressNotificationEvents: true,
	autoCreateTopic: true,
	pollRetryDelayMs: 5000,
	minRenameIntervalMs: 30_000,
	reactionEnabled: true,
	reactionRunningEmoji: '✍',
};
```

- [ ] **Step 7.2: 跑 config 相关测试 + 全量回归**

Run: `npx vitest run`
Expected: PASS — 全部通过（默认值新增字段不应破现有测试）

- [ ] **Step 7.3: 更新 docs/TELEGRAM.md 配置项参考表**

打开 `docs/TELEGRAM.md`，定位「配置项参考」表（约第 196 行的 markdown 表）。在表末尾追加两行：

```
| `reactionEnabled` | 在用户触发消息上加 ✍ reaction 表示 AI 在干活；Stop hook 触发时清掉。默认 true |
| `reactionRunningEmoji` | running 状态用哪个 Telegram 标准 emoji。默认 `✍`；群里限制了 Available Reactions 时改成允许列表里的（譬如 👀 / 🤔 / 👨‍💻） |
```

并把 JSON 示例（约第 180 行）也补两行：

```json
    "reactionEnabled": true,
    "reactionRunningEmoji": "✍",
```

放在 `"allowedFromUserIds": []` 之后即可。

- [ ] **Step 7.4: Commit**

```bash
git add src/config.js docs/TELEGRAM.md
git commit -m "feat(config): default telegram.reactionEnabled=true, runningEmoji=✍

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 端到端冒烟（手动）

**Files:** 无代码改动。

(此 task 是验收 checklist —— 可由用户在真实 Telegram supergroup 里跑一遍；如果确认 OK 就 close。)

- [ ] **Step 8.1: 启动 quadtodo 并验证 telegram bot 已起**

```bash
quadtodo doctor
```

应有 `✓ telegram bot token`、`✓ telegram.supergroupId` 等。如果之前已 stop，跑 `quadtodo start`。

- [ ] **Step 8.2: 在 supergroup General 触发任务**

Telegram 里 General topic 发：

```
帮我做：写一行 hello world 到 /tmp/hello.txt
```

预期：
- 那条触发消息**应被 bot 加 ✍ reaction**（在消息右下角小图标，移动端长按可见）
- 1-2 秒后收到「📁 选个工作目录...」向导
- topic 标题**不再有 🔄 前缀**

- [ ] **Step 8.3: 完成向导触发 PTY 启动**

走完向导，进新 topic 「#tXX ...」。

预期：
- bot 在新 topic 发欢迎 + AI 启动消息
- topic 标题**没有 🔄 前缀**（验证 running rename 已废）

- [ ] **Step 8.4: PTY 跑一轮回复，验证 reaction 清除**

Claude Code 完成第一轮回复（Stop hook） → 在 #tXX topic 收到 AI 回话内容。

回到 General topic，看那条原始触发消息：
- ✍ reaction **应该已被删掉**

- [ ] **Step 8.5: 在 #tXX topic 多轮交互**

在 #tXX topic 里回 `继续` 或任意文本：
- 那条消息**应被加 ✍**
- AI 完成下一轮 → ✍ 被清

- [ ] **Step 8.6: 任务结束**

PTY 自然结束 / 用户 stop：
- topic 标题加 `✅`/`❌`/`⏹` 前缀
- 所有残留 reaction（理论上 Stop hook 已清）兜底再清一次

- [ ] **Step 8.7: 多任务并发**

同时跑 2 个任务（2 个 topic）：交叉发消息，验证 reaction 加/删互不串扰。

---

## Self-Review

### Spec coverage
- ✅ 新增 `src/telegram-reaction-tracker.js`：Task 1 + 2
- ✅ 改造 `src/telegram-loading-status.js`（删 running/idle）：Task 4
- ✅ 改造 `telegram-bot.js dispatch`：Task 3
- ✅ 改造 `openclaw-hook.js` Stop/session-end：Task 5
- ✅ `server.js` 接线：Task 6
- ✅ 配置项默认值（reactionEnabled / reactionRunningEmoji）：Task 7
- ✅ 测试：reaction-tracker 单测（Task 1+2）、telegram-bot dispatch 集成（Task 3）、loading-status 改造（Task 4）、openclaw-hook 路由（Task 5）
- ✅ 文档更新（docs/TELEGRAM.md）：Task 7
- ✅ E2E 冒烟：Task 8

### Type / 名字一致性
- `noteUserMessage({ sessionId, chatId, messageId })`：Task 1 定义、Task 3 调用、Task 6 lazyRef proxy 名字一致
- `clearReactionsForSession(sessionId)`：Task 1 定义、Task 5 调用、Task 6 注入名字一致（与 lark-bot 同名，符合 spec 设计）
- `reactionTracker` 入参名：Task 3 createTelegramBot、Task 5 createOpenClawHookHandler、Task 6 server.js 全部一致
- `reactionEnabled` / `reactionRunningEmoji`：Task 1+2 测试、Task 7 默认值一致

### 测试粒度自查
- 每个新 API 有对应失败测试 → 实现 → 通过的 TDD 闭环
- error swallow 路径单独测试（Task 2）
- Task 4 的 loading-status 测试改动有完整新版（不是"参照旧的写"）
- Task 6 因 server.js 无单测，靠 Task 4/5 全量回归 + Task 8 手工冒烟兜底

### 风险确认
- Task 6 的循环依赖：用 lazyRef 模式（跟现有 wizard lazyRef 一致），不是新发明
- 改 telegram-loading-status 接口签名（markIdle/markRunning 改 no-op）：保留导出避免上游 wizard / hook 调用点报错；wizard 测试断言的是 `loadingTracker.start` 被调，no-op 不影响

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-09-telegram-emoji-reaction.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — 我每个 task 派一个新 subagent 实现，task 之间我做 review；适合多 task、变更面较大的计划。

**2. Inline Execution** — 我在当前 session 里按 task 顺序执行，每个 task 后给你 checkpoint。

哪种？
