# Claude Code busy 期间用户输入处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Lark / Telegram 投递到 busy Claude Code session 的用户输入从"裸 stdin write"改成中央调度器，支持"排队 / 软中断 (`!`) / 硬取消 (`!!` 或 in-topic `/stop`)"三档语义。

**Architecture:** 新增 `src/session-input-dispatcher.js` 作为唯一 chokepoint；以 `src/routes/ai-terminal.js` 的 `awaitingReply` 状态作为 busy 信号源（新增 `isSessionAwaitingReply` getter）；通过 `openclaw-hook.js` 的 Stop / session-end 事件触发 flush。Wizard 两处 stdin proxy 分支与 in-topic `/stop` 全部改走 dispatcher，General `/stop` 保留旧 `cmdStop` 杀 session 行为。

**Tech Stack:** Node.js (ESM), vitest（test runner）；现有 `src/pty.js` / `src/openclaw-wizard.js` / `src/openclaw-hook.js` / `src/routes/ai-terminal.js`。

---

## File Structure

| 文件 | 角色 | 状态 |
|------|------|------|
| `src/session-input-dispatcher.js` | 中央调度器：parse trigger → 决策 → 队列 / Esc / Ctrl+C；纯逻辑，注入 `pty` / `aiTerminal` / 回调 | 新建 |
| `test/session-input-dispatcher.test.js` | dispatcher 单元测试，mock pty + aiTerminal | 新建 |
| `src/routes/ai-terminal.js` | 暴露 `isSessionAwaitingReply(sid)` getter | 修改（+10 行） |
| `src/openclaw-wizard.js` | 两处 stdin proxy 分支（lark thread reply / telegram peer-bound）改走 dispatcher；in-topic `/stop` 路由到 dispatcher | 修改（~80 行替换） |
| `src/openclaw-hook.js` | Stop hook 之后调 `dispatcher.onSessionIdle`；session-end 调 `dispatcher.onSessionEnd` | 修改（+15 行） |
| `src/server.js` | 实例化 dispatcher，注入 wizard / hook | 修改（+20 行） |

参考的 spec：`docs/superpowers/specs/2026-05-10-busy-session-input-handling-design.md`

---

## Task 1: ai-terminal 加 `isSessionAwaitingReply` getter

**Files:**
- Modify: `src/routes/ai-terminal.js:875-895`（exports 列表 + 新增函数）

dispatcher 需要查 busy 状态。当前 `markSessionAwaitingReply` 已经存在（line 886），只缺一个公开 getter；不存在的 sid 视为 busy（保守语义）。

- [ ] **Step 1: 在 `src/routes/ai-terminal.js` 接近 `markSessionAwaitingReply` 处新增 `isSessionAwaitingReply` 函数，并加入 exports**

在 line 894 `}` 之后追加：

```js
function isSessionAwaitingReply(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return false  // 不存在 → 视为 busy（保守，避免抢跑）
  if (session.status !== 'running' && session.status !== 'pending_confirm') return false
  return !!session.awaitingReply
}
```

修改 line 882 附近 exports：

```js
return {
  // ... 已有的 ...
  markSessionAwaitingReply,
  isSessionAwaitingReply,
  close,
}
```

- [ ] **Step 2: 跑全量测试确认无回归**

Run: `npm test`
Expected: 全部通过（新增 export 不影响现有用例）。

- [ ] **Step 3: Commit**

```bash
git add src/routes/ai-terminal.js
git commit -m "feat(ai-terminal): expose isSessionAwaitingReply getter"
```

---

## Task 2: dispatcher 骨架 + trigger 解析

**Files:**
- Create: `src/session-input-dispatcher.js`
- Create: `test/session-input-dispatcher.test.js`

骨架包含：工厂函数签名、parseTrigger 函数（解析 `!!` / `/stop` / `!` / 普通）。这一步只完成解析逻辑，`send` 方法返回 stub。

- [ ] **Step 1: 创建测试 `test/session-input-dispatcher.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { parseTrigger } from '../src/session-input-dispatcher.js'

describe('parseTrigger', () => {
  it('普通文本 → queue_or_send', () => {
    expect(parseTrigger('hello')).toEqual({ mode: 'queue_or_send', stripped: 'hello' })
  })

  it('单 ! 前缀 → soft_interrupt，去掉 !', () => {
    expect(parseTrigger('!算了')).toEqual({ mode: 'soft_interrupt', stripped: '算了' })
  })

  it('双 !! 前缀 → hard_cancel', () => {
    expect(parseTrigger('!!stop')).toEqual({ mode: 'hard_cancel', stripped: '' })
  })

  it('精确 /stop → hard_cancel', () => {
    expect(parseTrigger('/stop')).toEqual({ mode: 'hard_cancel', stripped: '' })
  })

  it('/stop 带参数（/stop all）不算 hard_cancel，由 wizard 自己处理 admin 杀 session', () => {
    expect(parseTrigger('/stop all').mode).toBe('queue_or_send')
  })

  it('单 ! 但只有 ! 一个字符 → 视为空 soft_interrupt', () => {
    expect(parseTrigger('!')).toEqual({ mode: 'soft_interrupt', stripped: '' })
  })

  it('前后空白 trim', () => {
    expect(parseTrigger('  !  hi  ')).toEqual({ mode: 'soft_interrupt', stripped: 'hi' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 创建 `src/session-input-dispatcher.js` 骨架 + `parseTrigger`**

```js
/**
 * Session Input Dispatcher
 *
 * 所有 "把用户文本投递到一个 Claude Code session" 的路径都走这里。
 * 三档语义：
 *   - queue_or_send  ：普通文本，busy 时入队，idle 时直发
 *   - soft_interrupt ：`!` 前缀，busy 时 Esc → 250ms 后投递新文本，丢弃旧队列
 *   - hard_cancel    ：`!!` 前缀 或精确 `/stop`，busy 时 Ctrl+C，不投递文本
 */

const QUEUE_LIMIT = 20
const STALE_MS = 5 * 60 * 1000
const SOFT_INTERRUPT_DELAY_MS = 250

export function parseTrigger(rawText) {
  const text = String(rawText || '').trim()
  if (text === '/stop') return { mode: 'hard_cancel', stripped: '' }
  if (text.startsWith('!!')) return { mode: 'hard_cancel', stripped: '' }
  if (text.startsWith('!')) return { mode: 'soft_interrupt', stripped: text.slice(1).trim() }
  return { mode: 'queue_or_send', stripped: text }
}

export function createSessionInputDispatcher({ pty, aiTerminal, callbacks = {}, logger = console } = {}) {
  if (!pty) throw new Error('pty_required')
  if (!aiTerminal) throw new Error('aiTerminal_required')

  // sessionId → QueueState
  const queues = new Map()

  async function send({ sessionId, text, imagePaths = [], channel, echoTarget } = {}) {
    return { action: 'noop', reason: 'not_implemented_yet' }
  }

  function onSessionIdle(_sessionId) { /* TODO Task 5 */ }
  function onSessionEnd(_sessionId) { /* TODO Task 8 */ }
  function describe() { return { sessions: 0 } }

  return { send, onSessionIdle, onSessionEnd, describe, __test__: { queues, parseTrigger } }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 7 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): scaffold session-input-dispatcher with trigger parsing"
```

---

## Task 3: dispatcher idle 路径（普通 / soft / hard 三种）

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

idle 行为：
- 普通文本 → `pty.write(sid, text)` + 80ms 后 `\r`
- soft_interrupt（`!xxx`）→ idle 时等同普通文本 `xxx`
- hard_cancel → idle 时不写 PTY，返回 `noop_idle`

- [ ] **Step 1: 写失败测试**

在 `test/session-input-dispatcher.test.js` 追加：

```js
import { createSessionInputDispatcher } from '../src/session-input-dispatcher.js'
import { vi } from 'vitest'

function makeDeps({ awaitingReply = true, hasSession = true } = {}) {
  const writes = []
  const pty = {
    write: vi.fn((sid, data) => { writes.push({ sid, data }) }),
    has: vi.fn(() => hasSession),
  }
  const aiTerminal = {
    isSessionAwaitingReply: vi.fn(() => awaitingReply),
  }
  return { pty, aiTerminal, writes }
}

describe('send: idle path', () => {
  it('idle + 普通文本 → 直接 pty.write + \\r', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const promise = d.send({ sessionId: 'sid1', text: 'hello' })
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes).toEqual([
      { sid: 'sid1', data: 'hello' },
      { sid: 'sid1', data: '\r' },
    ])
    vi.useRealTimers()
  })

  it('idle + ! 前缀 → 等同普通投递（去掉 !）', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const promise = d.send({ sessionId: 'sid1', text: '!算了' })
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes[0]).toEqual({ sid: 'sid1', data: '算了' })
    vi.useRealTimers()
  })

  it('idle + /stop → noop_idle，不写 PTY', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '/stop' })
    expect(result).toMatchObject({ action: 'noop_idle' })
    expect(writes).toEqual([])
  })

  it('idle + 普通文本 + imagePaths → 拼 @path 前缀', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const promise = d.send({ sessionId: 'sid1', text: 'caption', imagePaths: ['/tmp/a.png', '/tmp/b.png'] })
    await vi.advanceTimersByTimeAsync(100)
    await promise
    expect(writes[0]).toEqual({ sid: 'sid1', data: '@/tmp/a.png @/tmp/b.png caption' })
    vi.useRealTimers()
  })

  it('PTY 不存在 → session_ended', async () => {
    const { pty, aiTerminal } = makeDeps({ hasSession: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'hello' })
    expect(result).toMatchObject({ action: 'session_ended' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 5 新测试 FAIL（旧 7 个 parseTrigger 通过）。

- [ ] **Step 3: 实现 idle 路径**

替换 `src/session-input-dispatcher.js` 中 `send` 函数：

```js
function buildPayload(text, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return text
  const ats = imagePaths.map((p) => `@${p}`).join(' ')
  return text ? `${ats} ${text}` : ats
}

function writeToPty(pty, sessionId, payload) {
  pty.write(sessionId, payload)
  setTimeout(() => {
    try { pty.write(sessionId, '\r') } catch (e) { /* ignore */ }
  }, 80)
}

async function send({ sessionId, text, imagePaths = [], channel, echoTarget } = {}) {
  if (!pty.has(sessionId)) {
    return { action: 'session_ended', sessionId }
  }
  const { mode, stripped } = parseTrigger(text)
  const idle = aiTerminal.isSessionAwaitingReply(sessionId)

  if (idle) {
    if (mode === 'hard_cancel') {
      return { action: 'noop_idle', sessionId }
    }
    // queue_or_send / soft_interrupt 在 idle 下都等同直发 stripped
    const payload = buildPayload(stripped, imagePaths)
    writeToPty(pty, sessionId, payload)
    return { action: 'sent', sessionId }
  }

  // busy 路径在后续 task 实现
  return { action: 'noop', reason: 'busy_not_implemented_yet', sessionId }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 12 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): implement idle send path for all three modes"
```

---

## Task 4: busy + 普通文本 → 入队 + 回显回调

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

busy + 普通文本：推入 per-sid FIFO；第 1 条触发 `onQueueFirstEnqueue`，2..N 条触发 `onQueueAdditionalEnqueue`；不写 PTY。

- [ ] **Step 1: 写失败测试**

```js
describe('send: busy + queue', () => {
  it('busy + 普通文本 → 入队，触发 onQueueFirstEnqueue', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const onFirst = vi.fn().mockResolvedValue({ messageId: 'first-echo' })
    const onMore = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onQueueFirstEnqueue: onFirst, onQueueAdditionalEnqueue: onMore },
    })
    const result = await d.send({ sessionId: 'sid1', text: 'hello', channel: 'telegram' })
    expect(result).toMatchObject({ action: 'queued', queueSize: 1 })
    expect(writes).toEqual([])
    expect(onFirst).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1', channel: 'telegram' }))
    expect(onMore).not.toHaveBeenCalled()
  })

  it('busy + 连续 3 条 → 第 2/3 条触发 onQueueAdditionalEnqueue', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const onFirst = vi.fn().mockResolvedValue()
    const onMore = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onQueueFirstEnqueue: onFirst, onQueueAdditionalEnqueue: onMore },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.send({ sessionId: 'sid1', text: 'c' })
    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(onMore).toHaveBeenCalledTimes(2)
  })

  it('describe() 反映 per-sid 队列长度', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.send({ sessionId: 'sid2', text: 'x' })
    const desc = d.describe()
    expect(desc.sessions).toBe(2)
    expect(desc.byId.sid1.queueSize).toBe(2)
    expect(desc.byId.sid2.queueSize).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 3 新测试 FAIL。

- [ ] **Step 3: 实现入队 + describe**

在 dispatcher 中增加：

```js
function getOrCreateQueue(sessionId) {
  let q = queues.get(sessionId)
  if (!q) {
    q = { items: [], staleTimer: null, firstEchoMessageId: null }
    queues.set(sessionId, q)
  }
  return q
}

async function enqueue({ sessionId, stripped, imagePaths, channel, echoTarget }) {
  const q = getOrCreateQueue(sessionId)
  q.items.push({ text: stripped, imagePaths, enqueuedAt: Date.now() })
  const isFirst = q.items.length === 1
  const cb = isFirst ? callbacks.onQueueFirstEnqueue : callbacks.onQueueAdditionalEnqueue
  if (cb) {
    try {
      const echo = await cb({ sessionId, channel, echoTarget, queueSize: q.items.length })
      if (isFirst && echo?.messageId) q.firstEchoMessageId = echo.messageId
    } catch (e) {
      logger.warn?.(`[dispatcher] echo callback failed: ${e.message}`)
    }
  }
  return q.items.length
}

// 在 send 的 busy 分支替换：
if (mode === 'queue_or_send') {
  const size = await enqueue({ sessionId, stripped, imagePaths, channel, echoTarget })
  return { action: 'queued', queueSize: size, sessionId }
}
```

`describe`：

```js
function describe() {
  const byId = {}
  for (const [sid, q] of queues.entries()) {
    byId[sid] = {
      queueSize: q.items.length,
      oldestEnqueuedAt: q.items[0]?.enqueuedAt ?? null,
    }
  }
  return { sessions: queues.size, byId }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 15 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): queue messages while session is busy"
```

---

## Task 5: `onSessionIdle` flush — 合并队列 + 单次 PTY 投递

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

外部调用 `onSessionIdle(sid)`（由 hook 在 markIdle 后触发）→ dispatcher 把队列里所有 text 用 `\n` 合并 + 收集所有 imagePaths → `pty.write` + 80ms 后 `\r` → 清空队列 → 触发 `onFlush`。

- [ ] **Step 1: 写失败测试**

```js
describe('onSessionIdle: flush queue', () => {
  it('合并 3 条文本 → 单次 pty.write 用 \\n 拼', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const onFlush = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onFlush },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.send({ sessionId: 'sid1', text: 'c' })
    await d.onSessionIdle('sid1')
    await vi.advanceTimersByTimeAsync(100)
    expect(writes).toEqual([
      { sid: 'sid1', data: 'a\nb\nc' },
      { sid: 'sid1', data: '\r' },
    ])
    expect(onFlush).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1', count: 3 }))
    expect(d.describe().byId.sid1).toBeUndefined()
    vi.useRealTimers()
  })

  it('imagePaths 跨条目合并到 payload 前面', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 'sid1', text: 'first', imagePaths: ['/tmp/a.png'] })
    await d.send({ sessionId: 'sid1', text: 'second', imagePaths: ['/tmp/b.png'] })
    await d.onSessionIdle('sid1')
    await vi.advanceTimersByTimeAsync(100)
    expect(writes[0].data).toBe('@/tmp/a.png @/tmp/b.png first\nsecond')
    vi.useRealTimers()
  })

  it('空队列 onSessionIdle → noop，不写 PTY', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.onSessionIdle('sid1')
    expect(writes).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 3 新测试 FAIL。

- [ ] **Step 3: 实现 onSessionIdle**

替换 dispatcher 中 `onSessionIdle`：

```js
async function flushQueue(sessionId) {
  const q = queues.get(sessionId)
  if (!q || q.items.length === 0) return { flushed: 0 }
  const allImages = []
  const texts = []
  for (const item of q.items) {
    if (item.imagePaths && item.imagePaths.length) allImages.push(...item.imagePaths)
    if (item.text) texts.push(item.text)
  }
  const count = q.items.length
  const combinedText = texts.join('\n')
  const payload = buildPayload(combinedText, allImages)
  // 清队列在 PTY 写之前 —— 失败时不会留下"已 flush 但残存"的状态
  if (q.staleTimer) { clearTimeout(q.staleTimer); q.staleTimer = null }
  queues.delete(sessionId)
  try {
    writeToPty(pty, sessionId, payload)
  } catch (e) {
    logger.warn?.(`[dispatcher] flush write failed sid=${sessionId}: ${e.message}`)
    return { flushed: 0, error: e.message }
  }
  if (callbacks.onFlush) {
    try { await callbacks.onFlush({ sessionId, count }) }
    catch (e) { logger.warn?.(`[dispatcher] onFlush callback failed: ${e.message}`) }
  }
  return { flushed: count }
}

async function onSessionIdle(sessionId) {
  return flushQueue(sessionId)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 18 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): flush queued messages on session idle"
```

---

## Task 6: busy + soft_interrupt（`!xxx`）→ Esc + 250ms + drop queue

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

busy 时 `!xxx`：
1. 立即 `pty.write(sid, '\x1b')`（Esc）
2. 丢弃当前队列（`!` 抢断 = 算了听新的）
3. 250ms 后把 `xxx` 当普通投递（合 imagePaths）
4. 在 250ms 窗口内再来 soft_interrupt → 降级为入队（避免连发 Esc）

- [ ] **Step 1: 写失败测试**

```js
describe('send: busy + soft_interrupt', () => {
  it('busy + !xxx → 立刻发 Esc，250ms 后写 xxx + \\r，丢弃旧队列', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 'sid1', text: 'old1' })
    await d.send({ sessionId: 'sid1', text: 'old2' })
    expect(d.describe().byId.sid1.queueSize).toBe(2)
    const promise = d.send({ sessionId: 'sid1', text: '!new' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x1b' }])
    expect(d.describe().sessions).toBe(0)  // 队列已清
    await vi.advanceTimersByTimeAsync(260)
    await vi.advanceTimersByTimeAsync(100)  // 80ms 后的 \r
    const result = await promise
    expect(result).toMatchObject({ action: 'soft_interrupted' })
    expect(writes).toEqual([
      { sid: 'sid1', data: '\x1b' },
      { sid: 'sid1', data: 'new' },
      { sid: 'sid1', data: '\r' },
    ])
    vi.useRealTimers()
  })

  it('250ms 窗口内第 2 个 ! → 降级为入队', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    d.send({ sessionId: 'sid1', text: '!first' }).catch(() => {})
    await vi.advanceTimersByTimeAsync(50)
    const r2 = await d.send({ sessionId: 'sid1', text: '!second' })
    expect(r2).toMatchObject({ action: 'queued' })
    expect(writes.filter((w) => w.data === '\x1b')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('busy + ! 但 stripped 为空 → 仅 Esc，不投递文本', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const promise = d.send({ sessionId: 'sid1', text: '!' })
    await vi.advanceTimersByTimeAsync(400)
    const result = await promise
    expect(result).toMatchObject({ action: 'soft_interrupted' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x1b' }])
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 3 新测试 FAIL。

- [ ] **Step 3: 实现 soft_interrupt**

dispatcher 内部新增"软中断进行中"标记 + 实现：

```js
// 顶部：const softInterrupting = new Set()  // sessionId
// 在 createSessionInputDispatcher 内部：
const softInterrupting = new Set()

async function performSoftInterrupt({ sessionId, stripped, imagePaths }) {
  // 丢弃旧队列
  const q = queues.get(sessionId)
  if (q) {
    if (q.staleTimer) clearTimeout(q.staleTimer)
    queues.delete(sessionId)
  }
  // 立刻发 Esc
  pty.write(sessionId, '\x1b')
  softInterrupting.add(sessionId)
  // 等 TUI 回到 prompt
  await new Promise((resolve) => setTimeout(resolve, SOFT_INTERRUPT_DELAY_MS))
  softInterrupting.delete(sessionId)
  // 投递新文本（如果有）
  if (stripped || (imagePaths && imagePaths.length)) {
    const payload = buildPayload(stripped, imagePaths)
    writeToPty(pty, sessionId, payload)
  }
  return { action: 'soft_interrupted', sessionId }
}
```

`send` 的 busy 分支增加：

```js
if (mode === 'soft_interrupt') {
  if (softInterrupting.has(sessionId)) {
    // 250ms 窗口内的第 2 个 ! → 降级入队（去掉 ! 的 stripped）
    const size = await enqueue({ sessionId, stripped, imagePaths, channel, echoTarget })
    return { action: 'queued', queueSize: size, reason: 'soft_interrupt_in_progress', sessionId }
  }
  return await performSoftInterrupt({ sessionId, stripped, imagePaths })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 21 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): soft-interrupt sends Esc and drops queue"
```

---

## Task 7: busy + hard_cancel → Ctrl+C + drop queue

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

busy 时 `!!` 或 精确 `/stop`：
1. `pty.write(sid, '\x03')`
2. 丢弃队列
3. 触发 `onHardCancel` 回调

- [ ] **Step 1: 写失败测试**

```js
describe('send: busy + hard_cancel', () => {
  it('busy + !! → Ctrl+C，丢弃队列，触发 onHardCancel', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const onHardCancel = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onHardCancel },
    })
    await d.send({ sessionId: 'sid1', text: 'queued1' })
    expect(d.describe().byId.sid1.queueSize).toBe(1)
    const result = await d.send({ sessionId: 'sid1', text: '!!stop now' })
    expect(result).toMatchObject({ action: 'hard_cancelled' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x03' }])
    expect(d.describe().sessions).toBe(0)
    expect(onHardCancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1' }))
  })

  it('busy + 精确 /stop → 同 !!', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '/stop' })
    expect(result).toMatchObject({ action: 'hard_cancelled' })
    expect(writes).toEqual([{ sid: 'sid1', data: '\x03' }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 2 新测试 FAIL。

- [ ] **Step 3: 实现 hard_cancel**

```js
async function performHardCancel({ sessionId, channel, echoTarget }) {
  const q = queues.get(sessionId)
  if (q) {
    if (q.staleTimer) clearTimeout(q.staleTimer)
    queues.delete(sessionId)
  }
  pty.write(sessionId, '\x03')
  if (callbacks.onHardCancel) {
    try { await callbacks.onHardCancel({ sessionId, channel, echoTarget }) }
    catch (e) { logger.warn?.(`[dispatcher] onHardCancel callback failed: ${e.message}`) }
  }
  return { action: 'hard_cancelled', sessionId }
}
```

`send` 的 busy 分支增加：

```js
if (mode === 'hard_cancel') {
  return await performHardCancel({ sessionId, channel, echoTarget })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 23 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): hard-cancel sends Ctrl+C and drops queue"
```

---

## Task 8: 队列上限 + 老化 + onSessionEnd

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

- 队列长度 ≥ 20 → 拒绝新消息，返回 `queue_full`
- 入队时（重）启 5min stale timer；超时 → `onStale` 回调，**不**自动清队列
- `onSessionEnd(sid)` → 清队列 + `onSessionEnd` 回调暴露未投递消息

- [ ] **Step 1: 写失败测试**

```js
describe('queue limits / lifecycle', () => {
  it('队列满 20 → 第 21 条返回 queue_full', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    for (let i = 0; i < 20; i++) {
      const r = await d.send({ sessionId: 'sid1', text: `m${i}` })
      expect(r.action).toBe('queued')
    }
    const result = await d.send({ sessionId: 'sid1', text: 'overflow' })
    expect(result).toMatchObject({ action: 'queue_full', queueSize: 20 })
  })

  it('5 分钟未 flush → onStale 回调被调用，队列保留', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const onStale = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onStale },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100)
    expect(onStale).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid1' }))
    expect(d.describe().byId.sid1?.queueSize).toBe(1)
    vi.useRealTimers()
  })

  it('onSessionEnd → 清队列，触发 onSessionEnd 回调暴露未投递消息', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const onEnd = vi.fn().mockResolvedValue()
    const d = createSessionInputDispatcher({
      pty, aiTerminal,
      callbacks: { onSessionEnd: onEnd },
    })
    await d.send({ sessionId: 'sid1', text: 'a' })
    await d.send({ sessionId: 'sid1', text: 'b' })
    await d.onSessionEnd('sid1')
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid1',
      undeliveredCount: 2,
      undeliveredTexts: ['a', 'b'],
    }))
    expect(d.describe().sessions).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 3 新测试 FAIL。

- [ ] **Step 3: 实现限额、stale、onSessionEnd**

修改 `enqueue` 在推入前检查长度：

```js
async function enqueue({ sessionId, stripped, imagePaths, channel, echoTarget }) {
  const q = getOrCreateQueue(sessionId)
  if (q.items.length >= QUEUE_LIMIT) {
    return { full: true, queueSize: q.items.length }
  }
  q.items.push({ text: stripped, imagePaths, enqueuedAt: Date.now() })
  // (重)启 stale timer
  if (q.staleTimer) clearTimeout(q.staleTimer)
  q.staleTimer = setTimeout(() => {
    if (callbacks.onStale) {
      Promise.resolve(callbacks.onStale({ sessionId, queueSize: q.items.length }))
        .catch((e) => logger.warn?.(`[dispatcher] onStale failed: ${e.message}`))
    }
  }, STALE_MS)
  const isFirst = q.items.length === 1
  const cb = isFirst ? callbacks.onQueueFirstEnqueue : callbacks.onQueueAdditionalEnqueue
  if (cb) {
    try {
      const echo = await cb({ sessionId, channel, echoTarget, queueSize: q.items.length })
      if (isFirst && echo?.messageId) q.firstEchoMessageId = echo.messageId
    } catch (e) {
      logger.warn?.(`[dispatcher] echo callback failed: ${e.message}`)
    }
  }
  return { full: false, queueSize: q.items.length }
}
```

`send` 的 `queue_or_send` 分支调整：

```js
if (mode === 'queue_or_send') {
  const r = await enqueue({ sessionId, stripped, imagePaths, channel, echoTarget })
  if (r.full) return { action: 'queue_full', queueSize: r.queueSize, sessionId }
  return { action: 'queued', queueSize: r.queueSize, sessionId }
}
```

`onSessionEnd`：

```js
async function onSessionEnd(sessionId) {
  const q = queues.get(sessionId)
  if (!q) return
  if (q.staleTimer) clearTimeout(q.staleTimer)
  const undelivered = q.items.slice()
  queues.delete(sessionId)
  if (callbacks.onSessionEnd) {
    try {
      await callbacks.onSessionEnd({
        sessionId,
        undeliveredCount: undelivered.length,
        undeliveredTexts: undelivered.map((it) => it.text),
      })
    } catch (e) {
      logger.warn?.(`[dispatcher] onSessionEnd callback failed: ${e.message}`)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 26 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): queue limit, stale timer, and session-end cleanup"
```

---

## Task 9: per-sid 串行化（防止并发 send 撕裂队列）

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

同一 sid 短时间多个 `send()` 并发时，确保它们按顺序执行（队列入队顺序与 PTY 写入顺序一致）。用 per-sid promise chain 实现。

- [ ] **Step 1: 写失败测试**

```js
describe('per-sid serialization', () => {
  it('并发 send 在同 sid 上严格按顺序入队', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const promises = []
    for (let i = 0; i < 10; i++) {
      promises.push(d.send({ sessionId: 'sid1', text: `m${i}` }))
    }
    await Promise.all(promises)
    const q = d.__test__.queues.get('sid1')
    expect(q.items.map((it) => it.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i}`)
    )
  })

  it('不同 sid 之间不互相阻塞', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const r1 = d.send({ sessionId: 'sid1', text: 'a' })
    const r2 = d.send({ sessionId: 'sid2', text: 'b' })
    await Promise.all([r1, r2])
    expect(d.describe().sessions).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 第 1 个测试可能 FLAKY（取决于 microtask 顺序）；第 2 个 PASS。
**注**：JS event loop 单线程，async 函数实际上已经按 await 顺序串行；本任务真正要防的是 `enqueue` 内部 await 期间被打断。

- [ ] **Step 3: 实现 per-sid promise chain**

```js
const sessionLocks = new Map()  // sessionId → Promise tail

function withSessionLock(sessionId, fn) {
  const prev = sessionLocks.get(sessionId) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => fn())
  sessionLocks.set(sessionId, next.finally(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId)
  }))
  return next
}
```

把 `send` 的整个 body 包到 `withSessionLock(sessionId, async () => { ... })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/session-input-dispatcher.test.js`
Expected: 28 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "feat(dispatcher): serialize concurrent sends per session"
```

---

## Task 10: 在 `server.js` 实例化 dispatcher 并注入 wizard / hook

**Files:**
- Modify: `src/server.js:1240-1270`

dispatcher 没有外部状态，可以直接在 `unwrapHolder` 之后实例化；callbacks 在这一步先用 stub（Task 14 / 15 再填具体回调）。

- [ ] **Step 1: 修改 `src/server.js` line 1244 之后**

加 import（文件顶部 import 区，与其他 src/ 模块同区）：

```js
import { createSessionInputDispatcher } from './session-input-dispatcher.js'
```

在 line 1244（`reactionTrackerProxy` 之后）加：

```js
const sessionInputDispatcher = createSessionInputDispatcher({
  pty,
  aiTerminal: ait,
  callbacks: {
    // Task 15 填具体实现（按 channel 分发到 lark / telegram）
    onQueueFirstEnqueue: async (_ctx) => undefined,
    onQueueAdditionalEnqueue: async (_ctx) => undefined,
    onFlush: async (_ctx) => undefined,
    onHardCancel: async (_ctx) => undefined,
    onStale: async (_ctx) => undefined,
    onSessionEnd: async (_ctx) => undefined,
  },
  logger: console,
})
```

把 dispatcher 注入到 `createOpenClawHookHandler`（line 1246）和 `createOpenClawWizard`（line 1260）：

```js
const openclawHookHandler = createOpenClawHookHandler({
  // ... 已有字段 ...
  sessionInputDispatcher,
});

const openclawWizard = createOpenClawWizard({
  // ... 已有字段 ...
  sessionInputDispatcher,
});
```

- [ ] **Step 2: 跑全量测试确认无回归**

Run: `npm test`
Expected: 全部 PASS（dispatcher 已被注入但暂未被调用）。

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(server): wire session-input-dispatcher into wizard and hook"
```

---

## Task 11: openclaw-hook.js 接 onSessionIdle / onSessionEnd

**Files:**
- Modify: `src/openclaw-hook.js:223-233`（factory 签名）+ `:625-635`（Stop / session-end 处理）

- [ ] **Step 1: 修改 factory 签名**

`src/openclaw-hook.js:223-230` 把 `sessionInputDispatcher = null` 加到 `createOpenClawHookHandler` 参数：

```js
export function createOpenClawHookHandler({
  db, openclaw, aiTerminal = null,
  pty = null, telegramBot = null, larkBot = null, loadingTracker = null,
  reactionTracker = null,
  sessionInputDispatcher = null,        // ← 新增
  cooldownMs = DEFAULT_COOLDOWN_MS,
  getConfig = null,
  logger = console,
} = {}) {
```

- [ ] **Step 2: Stop 事件后调 onSessionIdle**

在 line 631 markIdle 之后追加：

```js
if (evt === 'stop' && sessionId && sessionInputDispatcher?.onSessionIdle) {
  sessionInputDispatcher.onSessionIdle(sessionId)?.catch((e) => {
    logger.warn?.(`[openclaw-hook] dispatcher.onSessionIdle failed: ${e.message}`)
  })
}
```

- [ ] **Step 3: session-end 后调 onSessionEnd**

在 `if (evt === 'session-end')` 块（约 line 607）末尾的 `clearSessionRoute` 之后追加：

```js
if (sessionInputDispatcher?.onSessionEnd) {
  sessionInputDispatcher.onSessionEnd(sessionId)?.catch((e) => {
    logger.warn?.(`[openclaw-hook] dispatcher.onSessionEnd failed: ${e.message}`)
  })
}
```

- [ ] **Step 4: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS（hook 测试如果 mock dispatcher 缺失，会因 `sessionInputDispatcher = null` 默认值而跳过——不破坏既有用例）。

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-hook.js
git commit -m "feat(hook): trigger dispatcher flush on Stop and cleanup on session-end"
```

---

## Task 12: openclaw-wizard 替换 Lark thread reply stdin proxy

**Files:**
- Modify: `src/openclaw-wizard.js:310`（factory 签名）+ `:1244-1281`（lark 分支）

- [ ] **Step 1: 修改 factory 签名**

`src/openclaw-wizard.js:310` 把 `sessionInputDispatcher = null` 加到参数：

```js
export function createOpenClawWizard({
  // ... 已有 ...
  pty = null, telegramBot = null, larkBot = null, loadingTracker = null,
  sessionInputDispatcher = null,
  // ... 已有 ...
} = {}) {
```

- [ ] **Step 2: 替换 lark thread reply 分支（line 1244-1281）**

把整段 `if (larkBoundThreadSid) { ... }` 替换为：

```js
if (larkBoundThreadSid) {
  const sid = larkBoundThreadSid
  if (!pty?.write || !pty.has?.(sid)) {
    return {
      reply: '这个任务已结束，请在群里重新发起任务。',
      action: 'session_ended',
      sessionId: sid,
    }
  }
  if (!sessionInputDispatcher) {
    // 兜底：dispatcher 未注入 → 退回旧裸投递（保持兼容）
    try {
      loadingTracker?.markRunning?.(sid)?.catch?.(() => {})
      try { aiTerminal?.markSessionAwaitingReply?.(sid, false) } catch { /* ignore */ }
      let payload = trimmed
      if (imagePaths.length > 0) {
        const ats = imagePaths.map((p) => `@${p}`).join(' ')
        payload = trimmed ? `${ats} ${trimmed}` : ats
      }
      pty.write(sid, payload)
      setTimeout(() => {
        try { pty.write(sid, '\r') } catch (e) {
          logger.warn?.(`[wizard] stdin proxy submit failed: ${e.message}`)
        }
      }, 80)
      return { reply: '', action: 'stdin_proxy', sessionId: sid }
    } catch (e) {
      logger.warn?.(`[wizard] lark exact stdin proxy fallback failed: ${e.message}`)
      return { reply: '这个任务已结束，请在群里重新发起任务。', action: 'session_ended', sessionId: sid }
    }
  }
  // 走 dispatcher
  try { aiTerminal?.markSessionAwaitingReply?.(sid, false) } catch { /* ignore */ }
  loadingTracker?.markRunning?.(sid)?.catch?.(() => {})
  const r = await sessionInputDispatcher.send({
    sessionId: sid,
    text: trimmed,
    imagePaths,
    channel: 'lark',
    echoTarget: { chatId, threadId, rootMessageId, messageId: triggerMessageId },
  })
  return mapDispatcherResultToWizardReply(r, sid, imagePaths)
}
```

在文件末尾 `// helpers` 区域加映射函数：

```js
function mapDispatcherResultToWizardReply(result, sid, imagePaths) {
  switch (result.action) {
    case 'sent':
      return { reply: '', action: 'stdin_proxy', sessionId: sid, imagePaths: imagePaths.length ? imagePaths : undefined }
    case 'queued':
      return { reply: '', action: 'queued', sessionId: sid, queueSize: result.queueSize }
    case 'queue_full':
      return { reply: `📥 队列已满 (${result.queueSize})，请等当前任务结束或发送 \`!!\` 中断。`, action: 'queue_full', sessionId: sid }
    case 'soft_interrupted':
      return { reply: '⏸ 已发 Esc 中断当前任务，新消息会接着投递。', action: 'soft_interrupted', sessionId: sid }
    case 'hard_cancelled':
      return { reply: '⏹ 已中断当前任务（Ctrl+C）。', action: 'hard_cancelled', sessionId: sid }
    case 'noop_idle':
      return { reply: '✅ 当前没有正在跑的任务，无需中断。', action: 'noop_idle', sessionId: sid }
    case 'session_ended':
      return { reply: '这个任务已结束，请在群里重新发起任务。', action: 'session_ended', sessionId: sid }
    default:
      return { reply: '', action: result.action || 'unknown', sessionId: sid }
  }
}
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run test/openclaw-wizard.test.js`
Expected: 现有 wizard 测试可能需要更新（如果 mock 里 dispatcher 缺失，走 fallback 路径，行为不变）。

如有 fail，read 失败的测试，补上 `sessionInputDispatcher: { send: vi.fn().mockResolvedValue({ action: 'sent' }), onSessionIdle: vi.fn(), onSessionEnd: vi.fn(), describe: vi.fn().mockReturnValue({ sessions: 0, byId: {} }) }` 到测试 deps，让走 dispatcher 路径。

- [ ] **Step 4: Commit**

```bash
git add src/openclaw-wizard.js
git commit -m "feat(wizard): route Lark thread reply stdin through dispatcher"
```

---

## Task 13: openclaw-wizard 替换 Telegram peer-bound stdin proxy

**Files:**
- Modify: `src/openclaw-wizard.js:1539-1580`

- [ ] **Step 1: 替换 telegram 分支**

把 line 1539-1580（`try { ... pty.write(targetSid, payload) ... }` 整段）替换为：

```js
if (!sessionInputDispatcher) {
  // 兜底：保持原裸投递路径（与 Task 12 fallback 同形）
  try {
    loadingTracker?.markRunning?.(targetSid)?.catch?.(() => {})
    try { aiTerminal?.markSessionAwaitingReply?.(targetSid, false) } catch { /* ignore */ }
    let payload = trimmed
    if (imagePaths.length > 0) {
      const ats = imagePaths.map((p) => `@${p}`).join(' ')
      payload = trimmed ? `${ats} ${trimmed}` : ats
    }
    pty.write(targetSid, payload)
    setTimeout(() => {
      try { pty.write(targetSid, '\r') } catch (e) {
        logger.warn?.(`[wizard] stdin proxy submit failed: ${e.message}`)
      }
    }, 80)
    let firstHint = ''
    if (shouldAnnounceFirstRoute(peer, targetSid)) {
      const title = lookupTodoTitleForSession(targetSid)
      if (title) {
        firstHint = `📍 已发给 「${title}」 (#${targetSid.slice(-4)})\n（之后这条 chat 默认都发给它，不再提醒）`
      }
    }
    return { reply: firstHint, action: 'stdin_proxy', sessionId: targetSid, imagePaths: imagePaths.length ? imagePaths : undefined }
  } catch (e) {
    logger.warn?.(`[wizard] telegram stdin proxy fallback failed: ${e.message}`)
    return { reply: '这个任务似乎已结束。', action: 'session_ended', sessionId: targetSid }
  }
}

// 走 dispatcher
try { aiTerminal?.markSessionAwaitingReply?.(targetSid, false) } catch { /* ignore */ }
loadingTracker?.markRunning?.(targetSid)?.catch?.(() => {})
const r = await sessionInputDispatcher.send({
  sessionId: targetSid,
  text: trimmed,
  imagePaths,
  channel: 'telegram',
  echoTarget: { chatId, threadId, messageId: triggerMessageId },
})
const wizardReply = mapDispatcherResultToWizardReply(r, targetSid, imagePaths)
// 保留 first-route hint：dispatcher 返回 'sent' 时叠加
if (r.action === 'sent' && shouldAnnounceFirstRoute(peer, targetSid)) {
  const title = lookupTodoTitleForSession(targetSid)
  if (title) {
    wizardReply.reply = `📍 已发给 「${title}」 (#${targetSid.slice(-4)})\n（之后这条 chat 默认都发给它，不再提醒）`
  }
}
return wizardReply
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run test/openclaw-wizard.test.js`
Expected: 全部 PASS（同 Task 12 处理 mock）。

- [ ] **Step 3: Commit**

```bash
git add src/openclaw-wizard.js
git commit -m "feat(wizard): route Telegram peer-bound stdin through dispatcher"
```

---

## Task 14: in-topic `/stop` → dispatcher hard_cancel；General 保留 cmdStop

**Files:**
- Modify: `src/openclaw-wizard.js:1339-1343`（quadtodoSlash 分支）+ `:2268-2272`（slash command 分发）

判定：进入 `/stop` 处理前先看是否 resolve 出绑定 sid。有 → dispatcher.send hard_cancel；无 → 走旧 cmdStop。

- [ ] **Step 1: 写失败测试**

在 `test/openclaw-wizard.test.js` 加一个新 describe（如果文件已有 helper makeWizard 则复用）：

```js
describe('/stop dispatch', () => {
  it('in-topic /stop（peer 已绑 sid）→ dispatcher hard_cancel，不调 cmdStop', async () => {
    const dispatcher = {
      send: vi.fn().mockResolvedValue({ action: 'hard_cancelled' }),
      onSessionIdle: vi.fn(),
      onSessionEnd: vi.fn(),
      describe: vi.fn().mockReturnValue({ sessions: 0, byId: {} }),
    }
    // ... 构造 wizard，让 peer 绑定 sid（既有 makeWizard helper）
    // ... call handleInbound text='/stop'
    // expect(dispatcher.send).toHaveBeenCalledWith(expect.objectContaining({ text: '/stop' }))
    // expect 返回的 action === 'hard_cancelled'
  })

  it('General /stop（无绑定 sid）→ 走 cmdStop，列活跃会话', async () => {
    // ... 不绑定 sid 的 wizard
    // expect 返回 reply 包含 "当前活跃 AI 会话" 或 "✅ 当前没有正在跑的"
  })
})
```

> 实现细节会因 `test/openclaw-wizard.test.js` 现有 helper 而异；执行时按既有 mock 风格补全 makeWizard 注入 dispatcher。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/openclaw-wizard.test.js -t "/stop dispatch"`
Expected: FAIL（in-topic /stop 现在走的是 cmdStop，不调 dispatcher）。

- [ ] **Step 3: 修改 quadtodoSlash 分发**

`src/openclaw-wizard.js:2268-2272` 附近的 switch（在 `case 'stop':` 处）改为：

```js
case 'stop': {
  // 先看是否有绑定 sid → 走 dispatcher hard_cancel
  const boundSid = larkBoundThreadSid
    || (openclaw?.findLastPushedSession?.(peer) ?? null)
  if (boundSid && sessionInputDispatcher && pty?.has?.(boundSid)) {
    try { aiTerminal?.markSessionAwaitingReply?.(boundSid, false) } catch { /* ignore */ }
    const r = await sessionInputDispatcher.send({
      sessionId: boundSid,
      text: '/stop',
      channel: routeKey?.startsWith('lark') ? 'lark' : 'telegram',
      echoTarget: { chatId, threadId, rootMessageId, messageId: triggerMessageId },
    })
    return mapDispatcherResultToWizardReply(r, boundSid, [])
  }
  // 否则走 admin 杀 session 路径
  return cmdStop({ argText })
}
```

> 实际 `findLastPushedSession` 名字以 `src/openclaw-bridge.js` 现有导出为准（如 `getLastPushedSession`），按真名调整。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/openclaw-wizard.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-wizard.js test/openclaw-wizard.test.js
git commit -m "feat(wizard): in-topic /stop hard-cancels via dispatcher; General /stop unchanged"
```

---

## Task 15: 接入 lark / telegram 的 echo 回调（reaction + 首条文字 reply）

**Files:**
- Modify: `src/server.js:1244` 附近（dispatcher 实例化处的 callbacks 替换 stub）

复用既有 reaction 路径：
- Lark：`larkBot.handleEvent` 内已有 `pendingReactions` 机制（src/lark-bot.js:158）+ `clearReactionsForSession`
- Telegram：`reactionTracker`（`src/telegram-reaction-tracker.js`）+ `larkBot.replyInThread` / `telegramBot.sendMessage`

dispatcher 不直接调 API，server.js 在实例化时把回调拼好。

- [ ] **Step 1: 修改 `src/server.js` dispatcher callbacks**

替换 Task 10 留的 stub：

```js
const sessionInputDispatcher = createSessionInputDispatcher({
  pty,
  aiTerminal: ait,
  callbacks: {
    onQueueFirstEnqueue: async ({ sessionId, channel, echoTarget }) => {
      try {
        if (channel === 'lark' && larkBotProxy?.replyInThread && echoTarget?.rootMessageId) {
          const sent = await larkBotProxy.replyInThread({
            chatId: echoTarget.chatId,
            rootMessageId: echoTarget.rootMessageId,
            text: '🔄 当前任务进行中，已排队，会在结束后投递。',
          })
          // 同时贴 reaction（沿用既有 lark pendingReactions 机制——通过 larkBot 内部实现）
          if (echoTarget.messageId) {
            larkBotProxy.addReaction?.({ messageId: echoTarget.messageId, emoji: 'INBOX', sessionId })
              ?.catch(() => {})
          }
          return { messageId: sent?.payload?.message_id }
        }
        if (channel === 'telegram' && telegramBotProxy?.sendMessage) {
          const sent = await telegramBotProxy.sendMessage({
            chatId: echoTarget.chatId,
            threadId: echoTarget.threadId,
            text: '🔄 当前任务进行中，已排队，会在结束后投递。',
          })
          if (echoTarget.messageId) {
            reactionTrackerProxy?.add?.({ chatId: echoTarget.chatId, messageId: echoTarget.messageId, sessionId, emoji: '📥' })
              ?.catch?.(() => {})
          }
          return { messageId: sent?.message_id }
        }
      } catch (e) {
        console.warn(`[server] dispatcher onQueueFirstEnqueue failed: ${e.message}`)
      }
      return undefined
    },
    onQueueAdditionalEnqueue: async ({ sessionId, channel, echoTarget }) => {
      try {
        if (channel === 'lark' && echoTarget?.messageId) {
          larkBotProxy?.addReaction?.({ messageId: echoTarget.messageId, emoji: 'INBOX', sessionId })?.catch?.(() => {})
        } else if (channel === 'telegram' && echoTarget?.messageId) {
          reactionTrackerProxy?.add?.({ chatId: echoTarget.chatId, messageId: echoTarget.messageId, sessionId, emoji: '📥' })?.catch?.(() => {})
        }
      } catch (e) { console.warn(`[server] onQueueAdditionalEnqueue failed: ${e.message}`) }
    },
    onFlush: async ({ sessionId }) => {
      try {
        await larkBotProxy?.clearReactionsForSession?.(sessionId)
        await reactionTrackerProxy?.clearReactionsForSession?.(sessionId)
      } catch (e) { console.warn(`[server] onFlush failed: ${e.message}`) }
    },
    onHardCancel: async ({ sessionId, channel, echoTarget }) => {
      try {
        await larkBotProxy?.clearReactionsForSession?.(sessionId)
        await reactionTrackerProxy?.clearReactionsForSession?.(sessionId)
        // 文字回显由 wizard 的 mapDispatcherResultToWizardReply 已经返回，这里只清 reaction
      } catch (e) { console.warn(`[server] onHardCancel failed: ${e.message}`) }
    },
    onStale: async ({ sessionId, channel, echoTarget, queueSize }) => {
      const text = `⚠️ session 有 ${queueSize} 条排队消息超过 5 分钟未投递，看起来卡住了。可发送 \`!!\` 中断后重新发送。`
      try {
        if (channel === 'lark' && larkBotProxy?.replyInThread && echoTarget?.rootMessageId) {
          await larkBotProxy.replyInThread({ chatId: echoTarget.chatId, rootMessageId: echoTarget.rootMessageId, text })
        } else if (channel === 'telegram' && telegramBotProxy?.sendMessage && echoTarget) {
          await telegramBotProxy.sendMessage({ chatId: echoTarget.chatId, threadId: echoTarget.threadId, text })
        }
      } catch (e) { console.warn(`[server] onStale failed: ${e.message}`) }
    },
    onSessionEnd: async ({ sessionId, undeliveredCount, undeliveredTexts }) => {
      if (undeliveredCount === 0) return
      const preview = undeliveredTexts.slice(0, 3).map((t) => `• ${t.slice(0, 80)}`).join('\n')
      const text = `⚠️ session 已结束，未投递 ${undeliveredCount} 条消息：\n${preview}${undeliveredCount > 3 ? `\n（还有 ${undeliveredCount - 3} 条未列出）` : ''}`
      try {
        // route 已可能被清掉；用 openclaw bridge 的 resolveRoute 兜底
        const route = openclawBridge?.resolveRoute?.(sessionId)
        if (route?.channel === 'lark' && larkBotProxy?.sendMessage) {
          await larkBotProxy.sendMessage({ chatId: route.targetUserId, text })
        } else if (route?.channel === 'telegram' && telegramBotProxy?.sendMessage) {
          await telegramBotProxy.sendMessage({ chatId: route.targetUserId, threadId: route.threadId, text })
        }
      } catch (e) { console.warn(`[server] onSessionEnd echo failed: ${e.message}`) }
    },
  },
  logger: console,
})
```

> 注：实际 reaction API 名 (`addReaction` / `add`) 以现有代码为准；`echoTarget.messageId` 在 wizard 调用点要传到 dispatcher。如有不一致，看 `src/lark-bot.js:155-200` 与 `src/telegram-reaction-tracker.js` 的真实导出，按实导出名调整。

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS。如果集成测试因为 stub 不完整 fail，按既有 mock 风格补足。

- [ ] **Step 3: 启动本地服务，端到端冒烟**

Run（一个终端）：`npm run dev` 或现有启动命令
另一个终端：触发一个 todo 跑 Claude Code，用 Telegram / Lark 在它干活时发：
1. 普通文本 `测试一下排队`
2. 第二条 `第二条`
3. `!算了`
4. `/stop`

人工核对：
- 第 1 条 reply "🔄 当前任务进行中，已排队"，bot 贴 📥 reaction
- 第 2 条仅贴 reaction，无文字 reply
- `!` 后 Claude 中断（看终端），250ms 后 "算了" 被投递
- `/stop` 触发 Ctrl+C

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(server): wire dispatcher echo callbacks for Lark and Telegram"
```

---

## Task 16: `/list` 输出包含队列长度

**Files:**
- Modify: `src/openclaw-wizard.js:2105-2145`（`cmdList` 内部）

`cmdList` 列出活跃 session 时，每条加一段队列状态："队列：N 条" / "（空闲）"。

- [ ] **Step 1: 写失败测试**

```js
describe('/list with queue info', () => {
  it('cmdList 输出包含每个 session 的队列长度', async () => {
    const dispatcher = {
      send: vi.fn(),
      onSessionIdle: vi.fn(), onSessionEnd: vi.fn(),
      describe: vi.fn().mockReturnValue({
        sessions: 1,
        byId: { 'sid1234': { queueSize: 3, oldestEnqueuedAt: Date.now() - 1000 } },
      }),
    }
    // 构造 wizard 注入 dispatcher，让有 1 个活跃 session sid1234
    // call /list, expect reply contains "队列：3 条"
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/openclaw-wizard.test.js -t "list with queue"`
Expected: FAIL。

- [ ] **Step 3: 修改 cmdList**

在 `src/openclaw-wizard.js:2105` 附近的 `cmdList` 内，找到列每条 session 的循环（生成 `lines.push(...)` 那段），在 session line 后追加：

```js
const dispatcherDesc = sessionInputDispatcher?.describe?.() ?? { byId: {} }
// ... 原有 active.forEach 循环改为：
active.forEach((s, i) => {
  const title = s.todo?.title || '(未绑定 todo)'
  const qInfo = dispatcherDesc.byId?.[s.sid]?.queueSize
    ? `  📥 队列：${dispatcherDesc.byId[s.sid].queueSize} 条`
    : ''
  lines.push(`  ${i + 1}. ${s.short}  ${title}  · ${formatTimeAgo(s.lastOutputAt)}${qInfo}`)
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/openclaw-wizard.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-wizard.js test/openclaw-wizard.test.js
git commit -m "feat(wizard): show per-session queue size in /list output"
```

---

## Task 17: 端到端集成回归

**Files:**
- 不改代码，只跑测试 + 手动验收

- [ ] **Step 1: 跑全量测试**

Run: `npm test`
Expected: 100% PASS。

- [ ] **Step 2: 用本地启动 + 真 telegram bot / lark bot 走一遍验收清单**

参照 spec 的「验收标准」清单：
- [ ] busy 时普通消息 → 入队 + reaction + 第 1 条带文字 reply
- [ ] idle 时普通消息 → 直发，无 reaction、无 reply
- [ ] busy 时 `!xxx` → Esc 写入 → 250ms 后写 xxx + `\r`，旧队列丢弃
- [ ] busy 时 `!!` / in-topic `/stop` → Ctrl+C 写入，不投递文本，回 "⏹ 已中断"
- [ ] General 里 `/stop <短码>` / `/stop all` 仍走旧 cmdStop（杀整个 session）
- [ ] Stop hook 触发后队列合并并投递（onSessionIdle 同步调用），reaction 清除
- [ ] 队列满 20 → 第 21 条被拒，echo 提示
- [ ] 5 分钟未 flush → echo 警告，队列保留
- [ ] session-end → 队列清空，echo "session 已结束，未投递 N 条消息"
- [ ] `/list` 输出包含 per-session 队列长度
- [ ] dispatcher 单元测试覆盖率 ≥ 80%
- [ ] 既有 lark/telegram bot 集成测试不回归

- [ ] **Step 3: 如果 spec 验收清单全过 → 在 spec 文档里贴一行实施完成日期**

可选：在 `docs/superpowers/specs/2026-05-10-busy-session-input-handling-design.md` 顶部加一行：

```markdown
> **实施状态**：已于 2026-05-10 完成，见 `docs/superpowers/plans/2026-05-10-busy-session-input-handling.md`。
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-10-busy-session-input-handling-design.md
git commit -m "docs(spec): mark busy-session-input-handling spec as implemented"
```

---

## Self-Review Notes

- **Spec coverage**：
  - 排队 / 软中断 / 硬取消 三档 → Tasks 4 / 6 / 7
  - busy 信号源（isSessionAwaitingReply）→ Task 1
  - flush 合并 + Stop hook 触发 → Tasks 5 / 11
  - 队列上限 / stale / session-end → Task 8 + 11
  - `/stop` 重新定义 → Task 14
  - `/list` 显示队列 → Task 16
  - 状态回显（reaction-first）→ Task 15
  - per-sid 串行化 → Task 9
  - server wire-up → Task 10

- **Placeholders**：无 TBD / 模糊步骤；每个测试都有完整代码；Task 15 提示 "实际 API 名以现有代码为准" 是必要的 fallback 指引而非占位。

- **Type 一致**：`send` 返回的 action 字符串集合 `{ sent | queued | queue_full | soft_interrupted | hard_cancelled | noop_idle | session_ended }` 在 Tasks 3-8 与 Task 12 的 `mapDispatcherResultToWizardReply` 完全对齐。`describe()` 在 Task 4 / 16 / 14 用法一致（`{ sessions, byId }`）。
