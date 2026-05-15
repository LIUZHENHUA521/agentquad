# Cross-Channel User Input Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror user prompts across PC ↔ Telegram ↔ Lark so mobile sees full conversation context regardless of where the user typed.

**Architecture:** Install a new Claude/Codex `UserPromptSubmit` hook → `notify.js` → `/api/openclaw/hook` → `openclaw-hook.js` reads `hookPayload.user_prompt`. A 30s TTL dedup table inside `sessionInputDispatcher` lets the hook tell whether the prompt originated from Telegram / Lark or from the PC; `openclaw-bridge.broadcastEcho` then fans out `👤 <prompt>` to all bound IM routes except the origin.

**Tech Stack:** Node.js (ESM), Vitest, existing AgentQuad modules: `session-input-dispatcher.js`, `openclaw-bridge.js`, `openclaw-hook.js`, `openclaw-hook-installer.js`, `codex-hook-installer.js`, `templates/claude-hooks/notify.js`, `templates/codex-hooks/notify.js`, `server.js`.

**Spec:** [`docs/superpowers/specs/2026-05-15-cross-channel-user-input-mirror-design.md`](../specs/2026-05-15-cross-channel-user-input-mirror-design.md)

**Commit policy:** Per project memory ([Auto-push after commit](../../../../.claude/projects/-Users-liuzhenhua-Desktop-code-crazyCombo-quadtodo/memory/feedback_auto_push.md)), every `git commit` is followed by `git push origin main` in the same step.

---

## File Inventory

| File | Action | Responsibility |
|---|---|---|
| `src/session-input-dispatcher.js` | Modify | Add `recordOrigin` / `consumeOrigin`; record on every PTY user-text write; carry `channel` in queue items |
| `src/openclaw-bridge.js` | Modify | Add `broadcastEcho({ sessionId, message, excludeChannel })`; accept `getRoutesForSession` dep |
| `src/openclaw-hook.js` | Modify | Add `user-prompt-submit` event branch inside `handleClaude` (handles both Claude and Codex notify.js POSTs) |
| `src/openclaw-hook-installer.js` | Modify | Add `'UserPromptSubmit'` to `HOOK_EVENTS`; map to `'user-prompt-submit'` argv |
| `src/codex-hook-installer.js` | Modify | Change `UserPromptSubmit` argv mapping from `'notification'` to `'user-prompt-submit'` |
| `src/templates/claude-hooks/notify.js` | Modify | Bump `quadtodo-hook-version: 2` → `3` to force re-deploy |
| `src/templates/codex-hooks/notify.js` | Modify | Bump `quadtodo-hook-version: 2` → `3` to force re-deploy |
| `src/server.js` | Modify | Pass `getRoutesForSession` into bridge constructor |
| `test/session-input-dispatcher.test.js` | Modify | Add tests for `recordOrigin` / `consumeOrigin` |
| `test/openclaw-bridge.test.js` | Modify | Add tests for `broadcastEcho` |
| `test/openclaw-hook.test.js` | Modify | Add test for `user-prompt-submit` branch |
| `test/openclaw-hook-installer.test.js` | Modify | Assert UserPromptSubmit entry written |
| `test/codex-hook-installer.test.js` | Modify | Assert UserPromptSubmit maps to `user-prompt-submit` argv |

---

## Task 1: Dispatcher origin record/consume API (TDD, pure)

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

- [ ] **Step 1: Add failing tests at the bottom of `test/session-input-dispatcher.test.js`**

Append (keep existing imports / helpers as-is):

```javascript
describe('origin dedup table (recordOrigin / consumeOrigin)', () => {
  function makeMinimalDispatcher() {
    const pty = { write: vi.fn(), has: vi.fn(() => true) }
    const aiTerminal = { isSessionAwaitingReply: vi.fn(() => true) }
    return createSessionInputDispatcher({ pty, aiTerminal })
  }

  it('consumeOrigin 命中后返回 channel 并从表中移除（同 hash 第二次 miss）', () => {
    const d = makeMinimalDispatcher()
    d.recordOrigin('sid-1', 'hello world', 'telegram')
    expect(d.consumeOrigin('sid-1', 'hello world')).toBe('telegram')
    expect(d.consumeOrigin('sid-1', 'hello world')).toBe(null)
  })

  it('normalize：trim + 折叠连续 whitespace 后 hash 相等', () => {
    const d = makeMinimalDispatcher()
    d.recordOrigin('sid-1', 'hi   there', 'lark')
    expect(d.consumeOrigin('sid-1', '  hi there  ')).toBe('lark')
  })

  it('未记录的 sessionId → consumeOrigin 返回 null', () => {
    const d = makeMinimalDispatcher()
    expect(d.consumeOrigin('nope', 'x')).toBe(null)
  })

  it('TTL 过期后 consumeOrigin 返回 null', () => {
    vi.useFakeTimers()
    const d = makeMinimalDispatcher()
    d.recordOrigin('sid-1', 'aged', 'telegram')
    vi.advanceTimersByTime(31_000)
    expect(d.consumeOrigin('sid-1', 'aged')).toBe(null)
    vi.useRealTimers()
  })

  it('FIFO 上限：第 17 条 push 把最老一条挤出', () => {
    const d = makeMinimalDispatcher()
    for (let i = 0; i < 17; i++) d.recordOrigin('sid-1', `msg-${i}`, 'telegram')
    expect(d.consumeOrigin('sid-1', 'msg-0')).toBe(null)
    expect(d.consumeOrigin('sid-1', 'msg-16')).toBe('telegram')
  })

  it('空文本 / 空 channel / 空 sessionId 不抛错', () => {
    const d = makeMinimalDispatcher()
    expect(() => d.recordOrigin('', 'x', 'telegram')).not.toThrow()
    expect(() => d.recordOrigin('sid', '', 'telegram')).not.toThrow()
    expect(() => d.recordOrigin('sid', 'x', '')).not.toThrow()
    expect(d.consumeOrigin('sid', 'x')).toBe(null)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run test/session-input-dispatcher.test.js
```

Expected: failures with `d.recordOrigin is not a function` and `d.consumeOrigin is not a function`.

- [ ] **Step 3: Implement `recordOrigin` / `consumeOrigin` in `src/session-input-dispatcher.js`**

Near the top of the file (after the existing constants, before `parseTrigger`):

```javascript
import { createHash } from 'node:crypto'

const ORIGIN_TTL_MS = 30_000
const ORIGIN_LIMIT = 16

function normalizeAndHash(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ')
  return createHash('sha1').update(normalized).digest('hex')
}
```

Inside `createSessionInputDispatcher`, after `const softInterrupting = new Set()` (around line 57):

```javascript
  // sessionId → Array<{ hash, channel, ts }>。30s TTL，FIFO 上限 ORIGIN_LIMIT。
  // 用于让 UserPromptSubmit hook 区分"这条 prompt 来自 telegram / lark / PC"。
  const lastOrigins = new Map()

  function recordOrigin(sessionId, text, channel) {
    if (!sessionId || !text || !channel) return
    const now = Date.now()
    const prior = (lastOrigins.get(sessionId) || []).filter(e => now - e.ts < ORIGIN_TTL_MS)
    const trimmed = prior.slice(-(ORIGIN_LIMIT - 1))
    trimmed.push({ hash: normalizeAndHash(text), channel, ts: now })
    lastOrigins.set(sessionId, trimmed)
  }

  function consumeOrigin(sessionId, text) {
    if (!sessionId || !text) return null
    const arr = lastOrigins.get(sessionId)
    if (!arr || !arr.length) return null
    const h = normalizeAndHash(text)
    const now = Date.now()
    const idx = arr.findIndex(e => e.hash === h && now - e.ts < ORIGIN_TTL_MS)
    if (idx < 0) return null
    const { channel } = arr[idx]
    arr.splice(idx, 1)
    if (!arr.length) lastOrigins.delete(sessionId)
    return channel
  }
```

Find the `return` block at the end of `createSessionInputDispatcher` and add `recordOrigin, consumeOrigin` to the returned object. Locate the existing return (search for `return { send`). Example after edit:

```javascript
  return {
    send,
    onSessionIdle,
    onSessionEnd,
    describe,
    recordOrigin,
    consumeOrigin,
  }
```

(Keep whatever other names already appear in the return — only add the two new ones.)

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run test/session-input-dispatcher.test.js
```

Expected: all tests pass, including the new dedup-table block.

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "$(cat <<'EOF'
feat(dispatcher): add origin dedup table (recordOrigin/consumeOrigin)

Lets the UserPromptSubmit hook identify whether a Claude prompt
originated from Telegram, Lark, or PC. 30s TTL, FIFO cap of 16,
SHA-1 hash over whitespace-normalized text.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 2: Dispatcher integration — record at PTY-write call sites

**Files:**
- Modify: `src/session-input-dispatcher.js`
- Modify: `test/session-input-dispatcher.test.js`

- [ ] **Step 1: Add failing integration tests in `test/session-input-dispatcher.test.js`**

Append:

```javascript
describe('dispatcher integration: recordOrigin on PTY write', () => {
  it('idle 直发 → recordOrigin(sid, text, channel) 命中', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 's1', text: 'hi from tg', channel: 'telegram' })
    await vi.runAllTimersAsync()
    expect(d.consumeOrigin('s1', 'hi from tg')).toBe('telegram')
    vi.useRealTimers()
  })

  it('soft interrupt 投递新文本 → recordOrigin 命中', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const p = d.send({ sessionId: 's1', text: '!算了', channel: 'lark' })
    await vi.advanceTimersByTimeAsync(400)
    await p
    // soft_interrupt 的 stripped 是 '算了'
    expect(d.consumeOrigin('s1', '算了')).toBe('lark')
    vi.useRealTimers()
  })

  it('flushQueue → 合并文本 recordOrigin 命中（用 last enqueued channel）', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 's1', text: 'first', channel: 'telegram' })
    await d.send({ sessionId: 's1', text: 'second', channel: 'lark' })
    await d.onSessionIdle('s1')
    await vi.runAllTimersAsync()
    expect(d.consumeOrigin('s1', 'first\nsecond')).toBe('lark')
    vi.useRealTimers()
  })

  it('hard_cancel 不写文本 → 不调用 recordOrigin', async () => {
    const { pty, aiTerminal } = makeDeps({ awaitingReply: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    await d.send({ sessionId: 's1', text: '!!stop', channel: 'telegram' })
    expect(d.consumeOrigin('s1', '')).toBe(null)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run test/session-input-dispatcher.test.js -t 'dispatcher integration'
```

Expected: failures. The combined-flush test will fail (consumeOrigin returns null because no recording happened on flush).

- [ ] **Step 3: Wire `recordOrigin` calls in `src/session-input-dispatcher.js`**

In `enqueue`, store `channel` per item. Find the `q.items.push(...)` line (~line 73) and change:

```javascript
    q.items.push({ text: stripped, imagePaths, enqueuedAt: Date.now() })
```

to:

```javascript
    q.items.push({ text: stripped, imagePaths, channel, enqueuedAt: Date.now() })
```

In `send`, idle branch (locate `writeToPty(pty, sessionId, payload, logger); markBusyAfterWrite(...)` inside `if (idle)`):

```javascript
    if (idle) {
      if (mode === 'hard_cancel') {
        return { action: 'noop_idle', sessionId }
      }
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
      markBusyAfterWrite(aiTerminal, sessionId)
      if (channel && stripped) recordOrigin(sessionId, stripped, channel)
      return { action: 'sent', sessionId }
    }
```

In `performSoftInterrupt`, thread `channel` through the function so it can be recorded after the delayed write.

Locate the call in `send` (search for `return await performSoftInterrupt`):

```javascript
      return await performSoftInterrupt({ sessionId, stripped, imagePaths })
```

Change to:

```javascript
      return await performSoftInterrupt({ sessionId, stripped, imagePaths, channel })
```

Change the function declaration from:

```javascript
  async function performSoftInterrupt({ sessionId, stripped, imagePaths }) {
```

to:

```javascript
  async function performSoftInterrupt({ sessionId, stripped, imagePaths, channel }) {
```

Inside the function, find the block that writes the new text after the Esc delay:

```javascript
    if (stripped || (imagePaths && imagePaths.length)) {
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
      markBusyAfterWrite(aiTerminal, sessionId)
    }
```

Replace with:

```javascript
    if (stripped || (imagePaths && imagePaths.length)) {
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
      markBusyAfterWrite(aiTerminal, sessionId)
      if (channel && stripped) recordOrigin(sessionId, stripped, channel)
    }
```

In `flushQueue`, after `writeToPty(pty, sessionId, payload, logger); markBusyAfterWrite(...)`:

```javascript
    try {
      writeToPty(pty, sessionId, payload, logger)
      markBusyAfterWrite(aiTerminal, sessionId)
      // 取队列里最新的 channel；混合 channel 场景极少见，echo 会跳过那一个 channel
      const lastChan = q.items[q.items.length - 1]?.channel
      if (lastChan && combinedText) recordOrigin(sessionId, combinedText, lastChan)
    } catch (e) {
```

Replace the existing `try { writeToPty ... markBusyAfterWrite ... }` block accordingly.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run test/session-input-dispatcher.test.js
```

Expected: all dispatcher tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/session-input-dispatcher.js test/session-input-dispatcher.test.js
git commit -m "$(cat <<'EOF'
feat(dispatcher): record origin channel on every user-text PTY write

Wires recordOrigin into idle send / soft-interrupt / flush paths.
Queue items now carry channel so the merged flush text uses the most
recently enqueued channel as origin.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 3: `openclaw-bridge.broadcastEcho`

**Files:**
- Modify: `src/openclaw-bridge.js`
- Modify: `test/openclaw-bridge.test.js`

- [ ] **Step 1: Add failing tests in `test/openclaw-bridge.test.js`**

Append:

```javascript
describe('openclaw-bridge.broadcastEcho', () => {
  function makeBridgeWithRoutes({ telegramRoute, larkRoute, larkReply = { ok: true, payload: {} }, telegramToken = 'tok' } = {}) {
    const larkBot = { replyInThread: vi.fn().mockResolvedValue(larkReply) }
    const telegramSender = vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 9 } })
    const bridge = createOpenClawBridge({
      getConfig: () => ({ telegram: { botToken: telegramToken } }),
      spawnFn: vi.fn(),
      logger: { warn() {}, info() {} },
      telegramSender,
      getRoutesForSession: () => ({ telegram: telegramRoute, lark: larkRoute }),
    })
    bridge.setLarkBot?.(larkBot)
    return { bridge, larkBot, telegramSender }
  }

  it('双路由 + 无 excludeChannel → 同时发 telegram + lark', async () => {
    const { bridge, larkBot, telegramSender } = makeBridgeWithRoutes({
      telegramRoute: { threadId: 7, targetUserId: 'tg-user' },
      larkRoute: { rootMessageId: 'om_abc', targetUserId: 'lk-user' },
    })
    const r = await bridge.broadcastEcho({ sessionId: 'sid', message: '👤 hi' })
    expect(telegramSender).toHaveBeenCalledOnce()
    expect(telegramSender.mock.calls[0][0]).toMatchObject({ chatId: 'tg-user', threadId: 7, text: '👤 hi' })
    expect(larkBot.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_abc', text: '👤 hi' })
    expect(r.telegram?.ok).toBe(true)
    expect(r.lark?.ok).toBe(true)
  })

  it('excludeChannel=telegram → 只发 lark', async () => {
    const { bridge, larkBot, telegramSender } = makeBridgeWithRoutes({
      telegramRoute: { threadId: 7, targetUserId: 'tg-user' },
      larkRoute: { rootMessageId: 'om_abc', targetUserId: 'lk-user' },
    })
    await bridge.broadcastEcho({ sessionId: 'sid', message: '👤 hi', excludeChannel: 'telegram' })
    expect(telegramSender).not.toHaveBeenCalled()
    expect(larkBot.replyInThread).toHaveBeenCalledOnce()
  })

  it('excludeChannel=lark → 只发 telegram', async () => {
    const { bridge, larkBot, telegramSender } = makeBridgeWithRoutes({
      telegramRoute: { threadId: 7, targetUserId: 'tg-user' },
      larkRoute: { rootMessageId: 'om_abc', targetUserId: 'lk-user' },
    })
    await bridge.broadcastEcho({ sessionId: 'sid', message: '👤 hi', excludeChannel: 'lark' })
    expect(telegramSender).toHaveBeenCalledOnce()
    expect(larkBot.replyInThread).not.toHaveBeenCalled()
  })

  it('只绑 telegram，没绑 lark → 只发 telegram', async () => {
    const { bridge, larkBot, telegramSender } = makeBridgeWithRoutes({
      telegramRoute: { threadId: 7, targetUserId: 'tg-user' },
      larkRoute: null,
    })
    await bridge.broadcastEcho({ sessionId: 'sid', message: '👤 hi' })
    expect(telegramSender).toHaveBeenCalledOnce()
    expect(larkBot.replyInThread).not.toHaveBeenCalled()
  })

  it('getRoutesForSession 未注入 → 返回 skipped', async () => {
    const bridge = createOpenClawBridge({
      getConfig: () => ({}),
      spawnFn: vi.fn(),
      logger: { warn() {}, info() {} },
    })
    const r = await bridge.broadcastEcho({ sessionId: 'sid', message: '👤 hi' })
    expect(r.skipped).toBe(true)
  })

  it('sessionId / message 缺失 → 返回 skipped 不报错', async () => {
    const { bridge } = makeBridgeWithRoutes({ telegramRoute: null, larkRoute: null })
    expect((await bridge.broadcastEcho({})).skipped).toBe(true)
    expect((await bridge.broadcastEcho({ sessionId: 's' })).skipped).toBe(true)
    expect((await bridge.broadcastEcho({ message: 'm' })).skipped).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run test/openclaw-bridge.test.js -t 'broadcastEcho'
```

Expected: failures — `bridge.broadcastEcho is not a function` and `createOpenClawBridge` not accepting `getRoutesForSession` / `telegramSender`.

- [ ] **Step 3: Add `getRoutesForSession` to the factory signature**

Open `src/openclaw-bridge.js`. `createOpenClawBridge` already destructures `telegramSender = sendViaTelegramAPI` (line ~132). Add `getRoutesForSession = null` to the same destructure block:

```javascript
export function createOpenClawBridge({
  // ...existing params (getConfig, spawnFn, cliBin, logger, telegramSender, ...)...
  getRoutesForSession = null,
} = {}) {
```

- [ ] **Step 4: Implement `broadcastEcho` in `src/openclaw-bridge.js`**

Add the function inside `createOpenClawBridge`, just before the `return { ... }`:

```javascript
  /**
   * 把 user prompt echo 到所有已绑定的 IM thread，排除 origin channel。
   * 路由从注入的 getRoutesForSession 拿（读 db 双路由），不依赖 in-memory sessionRoutes
   * （后者每 session 只有一条 route，无法跨 telegram + lark 同时发）。
   *
   * 失败一律静默 warn —— echo 是辅助路径，不能影响 agent 的 Stop hook 主流程。
   */
  async function broadcastEcho({ sessionId, message, excludeChannel } = {}) {
    if (!sessionId || !message) return { skipped: true, reason: 'missing_args' }
    if (typeof getRoutesForSession !== 'function') return { skipped: true, reason: 'no_routes_fn' }
    if (!rateLimitOk()) return { skipped: true, reason: 'rate_limited' }

    let routes
    try {
      routes = getRoutesForSession(sessionId) || {}
    } catch (e) {
      logger?.warn?.(`[openclaw-bridge] broadcastEcho getRoutesForSession threw: ${e.message}`)
      return { skipped: true, reason: 'routes_lookup_failed' }
    }
    const { telegram: tg, lark: lk } = routes
    const results = { telegram: null, lark: null }

    if (tg?.threadId && tg?.targetUserId && excludeChannel !== 'telegram') {
      const token = getTelegramTokenFromConfig(getConfig())
      if (token) {
        try {
          results.telegram = await telegramSender({
            token,
            chatId: String(tg.targetUserId),
            threadId: Number(tg.threadId),
            text: message,
            logger,
          })
          if (results.telegram?.ok) recordSend()
        } catch (e) {
          logger?.warn?.(`[openclaw-bridge] broadcastEcho telegram threw: ${e.message}`)
          results.telegram = { ok: false, reason: 'threw', detail: e.message }
        }
      } else {
        results.telegram = { ok: false, reason: 'no_token' }
      }
    }

    if (lk?.rootMessageId && excludeChannel !== 'lark' && larkBot?.replyInThread) {
      try {
        results.lark = await larkBot.replyInThread({
          rootMessageId: String(lk.rootMessageId),
          text: message,
        })
        if (results.lark?.ok) recordSend()
      } catch (e) {
        logger?.warn?.(`[openclaw-bridge] broadcastEcho lark threw: ${e.message}`)
        results.lark = { ok: false, reason: 'threw', detail: e.message }
      }
    }

    return results
  }
```

Then add `broadcastEcho` to the returned object at the end of `createOpenClawBridge`. Locate the existing return (search for `return {` near the end; matches `postText, registerSessionRoute, ...`) and append `broadcastEcho` to the list.

- [ ] **Step 5: Run tests to confirm they pass**

```bash
npx vitest run test/openclaw-bridge.test.js
```

Expected: all existing bridge tests still pass, plus the new `broadcastEcho` block.

- [ ] **Step 6: Commit**

```bash
git add src/openclaw-bridge.js test/openclaw-bridge.test.js
git commit -m "$(cat <<'EOF'
feat(bridge): add broadcastEcho for cross-channel user prompt mirror

Fans out a single echo message to telegram + lark routes (minus
excludeChannel), reading both bound routes from injected
getRoutesForSession. Reuses existing rate-limit + sender path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 4: Wire `getRoutesForSession` from `server.js`

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: Add `getRoutesForSession` to `createOpenClawBridge` call**

In `src/server.js`, locate `const openclawBridge = createOpenClawBridge({ ... })` (around line 1186). Update the call to:

```javascript
const openclawBridge = createOpenClawBridge({
  getConfig: () => loadConfig({ rootDir: configRootDir }),
  getRoutesForSession: (sessionId) => {
    if (!sessionId) return { telegram: null, lark: null }
    // 优先用 in-memory session 拿 todoId（O(1)），失败再 fallback listTodos 全扫
    let todoId = null
    try {
      const sess = ait?.sessions?.get?.(sessionId)
      todoId = sess?.todoId || null
    } catch { /* ignore */ }
    if (todoId) {
      try {
        const todo = db.getTodo?.(todoId)
        const ai = (todo?.aiSessions || []).find(s => s?.sessionId === sessionId)
        if (ai) return { telegram: ai.telegramRoute || null, lark: ai.larkRoute || null }
      } catch { /* fallthrough */ }
    }
    try {
      const todos = db.listTodos?.({ status: 'all', archived: 'all' }) || []
      for (const t of todos) {
        const ai = (t.aiSessions || []).find(s => s?.sessionId === sessionId)
        if (ai) return { telegram: ai.telegramRoute || null, lark: ai.larkRoute || null }
      }
    } catch { /* ignore */ }
    return { telegram: null, lark: null }
  },
});
```

Note: `ait` is the AI Terminal instance; verify the variable name in context — search the file for `const ait = ` to confirm. If different, use the actual local name.

- [ ] **Step 2: Run all tests to make sure nothing regresses**

```bash
npx vitest run
```

Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "$(cat <<'EOF'
feat(server): inject getRoutesForSession into openclaw-bridge

Resolves a sessionId to its persisted telegramRoute + larkRoute via
ait.sessions lookup with listTodos fallback, so broadcastEcho can fan
out across both channels.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 5: Hook installers — emit `user-prompt-submit` event name

**Files:**
- Modify: `src/openclaw-hook-installer.js`
- Modify: `src/codex-hook-installer.js`
- Modify: `test/openclaw-hook-installer.test.js`
- Modify: `test/codex-hook-installer.test.js`

- [ ] **Step 1: Add failing test in `test/openclaw-hook-installer.test.js`**

Find the existing "installs hooks" describe block. Append a new test (adjust setup helpers as needed):

```javascript
it('installs UserPromptSubmit hook mapped to user-prompt-submit argv', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qt-hook-'))
  const settings = join(tmp, 'settings.json')
  writeFileSync(settings, '{}')
  const script = join(tmp, 'notify.js')
  writeFileSync(script, '// quadtodo-hook-version: 3\n')
  installHooks({ settingsPath: settings, hookScriptPath: script, uninstallMarkerPath: join(tmp, '.uninstalled') })
  const data = JSON.parse(readFileSync(settings, 'utf8'))
  expect(Array.isArray(data.hooks?.UserPromptSubmit)).toBe(true)
  const cmd = data.hooks.UserPromptSubmit[0].hooks[0].command
  expect(cmd).toContain('user-prompt-submit')
})
```

(If the test file does not yet import `mkdtempSync` / `writeFileSync` / `readFileSync` / `tmpdir` / `join`, add them — match the style of existing imports in that file.)

- [ ] **Step 2: Add failing test in `test/codex-hook-installer.test.js`**

```javascript
it('UserPromptSubmit maps to user-prompt-submit argv (not notification)', () => {
  // 取出 codex-hook-installer 里 buildHookEntry 的输出。最便捷做法：runtime install 后
  // 读 hooks.json 验证 argv。如果该测试文件已有 install helper，复用之。
  const tmp = mkdtempSync(join(tmpdir(), 'qt-codex-hook-'))
  const hooksJson = join(tmp, 'hooks.json')
  const configToml = join(tmp, 'config.toml')
  const script = join(tmp, 'notify.js')
  writeFileSync(script, '// quadtodo-hook-version: 3\n')
  installCodexHooks({
    hooksJsonPath: hooksJson,
    configTomlPath: configToml,
    hookScriptPath: script,
    uninstallMarkerPath: join(tmp, '.uninstalled'),
  })
  const data = JSON.parse(readFileSync(hooksJson, 'utf8'))
  const ups = data.UserPromptSubmit || data.hooks?.UserPromptSubmit
  expect(ups).toBeTruthy()
  const entry = Array.isArray(ups) ? ups[0] : ups
  const cmd = entry.hooks[0].command
  expect(cmd).toContain('user-prompt-submit')
  expect(cmd).not.toContain(' notification')
})
```

(Use the same import style and parameter names that the existing tests in `test/codex-hook-installer.test.js` already use. If function is named differently — e.g. `installHooks` exported from `codex-hook-installer.js` — adjust accordingly.)

- [ ] **Step 3: Run tests to confirm failure**

```bash
npx vitest run test/openclaw-hook-installer.test.js test/codex-hook-installer.test.js
```

Expected: the two new tests fail (UserPromptSubmit not present / argv is `notification`).

- [ ] **Step 4: Update `src/openclaw-hook-installer.js`**

```javascript
// 之前
const HOOK_EVENTS = ['Stop', 'Notification', 'SessionEnd']
// 之后
const HOOK_EVENTS = ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit']
```

And in `buildHookEntry`:

```javascript
function buildHookEntry(event, hookScriptPath) {
  const eventLower = event === 'SessionEnd' ? 'session-end'
    : event === 'Notification' ? 'notification'
    : event === 'UserPromptSubmit' ? 'user-prompt-submit'
    : 'stop'
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: `node ${hookScriptPath} ${eventLower}`,
        [QUADTODO_MANAGED_KEY]: true,
      },
    ],
    [QUADTODO_MANAGED_KEY]: true,
  }
}
```

- [ ] **Step 5: Update `src/codex-hook-installer.js`**

```javascript
function buildHookEntry(event, hookScriptPath) {
  const eventLower = event === 'UserPromptSubmit' ? 'user-prompt-submit' : 'stop'
  return {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `node ${hookScriptPath} ${eventLower}`,
        timeout: 30,
        [MANAGED_KEY]: true,
      },
    ],
    [MANAGED_KEY]: true,
  }
}
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/openclaw-hook-installer.test.js test/codex-hook-installer.test.js
```

Expected: all green, including the new entries.

- [ ] **Step 7: Commit**

```bash
git add src/openclaw-hook-installer.js src/codex-hook-installer.js test/openclaw-hook-installer.test.js test/codex-hook-installer.test.js
git commit -m "$(cat <<'EOF'
feat(hook-installer): install UserPromptSubmit → user-prompt-submit

Claude installer adds a fourth hook event. Codex installer renames the
existing UserPromptSubmit argv from 'notification' (legacy alias) to
'user-prompt-submit' so the handler can route it explicitly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 6: `notify.js` version bump (Claude + Codex)

**Files:**
- Modify: `src/templates/claude-hooks/notify.js`
- Modify: `src/templates/codex-hooks/notify.js`

- [ ] **Step 1: Bump Claude notify.js header**

In `src/templates/claude-hooks/notify.js`, change the header line:

```javascript
// quadtodo-hook-version: 2
```

to:

```javascript
// quadtodo-hook-version: 3
```

- [ ] **Step 2: Bump Codex notify.js header**

In `src/templates/codex-hooks/notify.js`:

```javascript
// quadtodo-hook-version: 2
```

→

```javascript
// quadtodo-hook-version: 3
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run
```

Expected: all green (version bump shouldn't change behavior).

- [ ] **Step 4: Commit**

```bash
git add src/templates/claude-hooks/notify.js src/templates/codex-hooks/notify.js
git commit -m "$(cat <<'EOF'
chore(hook-templates): bump version to 3 to force re-deploy

The installer rewrites the on-disk script when the template version is
higher than the installed version. Required so existing AgentQuad users
get the new UserPromptSubmit entry on next start.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 7: `openclaw-hook` `user-prompt-submit` branch

**Files:**
- Modify: `src/openclaw-hook.js`
- Modify: `test/openclaw-hook.test.js`

- [ ] **Step 1: Add failing test in `test/openclaw-hook.test.js`**

Append a new describe block:

```javascript
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
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npx vitest run test/openclaw-hook.test.js -t 'user-prompt-submit'
```

Expected: all five new tests fail (no handler branch).

- [ ] **Step 3: Implement the branch in `src/openclaw-hook.js`**

Locate `async function handleClaude({ event, sessionId, todoId, todoTitle, hookPayload } = {})` (around line 632). At the top of that function, right after the `const evt = String(event).toLowerCase()` line and the route-recovery block, add an early branch for `user-prompt-submit` BEFORE any of the existing Stop / Notification logic:

```javascript
    if (evt === 'user-prompt-submit') {
      if (!sessionId) return { ok: true, action: 'skipped', reason: 'no_session' }
      const promptRaw =
        (hookPayload && typeof hookPayload === 'object' && (
          hookPayload.user_prompt ||
          hookPayload.prompt ||
          hookPayload.user_message ||
          hookPayload.message
        )) || ''
      const prompt = String(promptRaw).trim()
      if (!prompt) return { ok: true, action: 'skipped', reason: 'empty_prompt' }

      // 截断：>2000 字符 → 取前 2000 + 末尾标注总字数
      const MAX = 2000
      const truncated = prompt.length > MAX
        ? `${prompt.slice(0, MAX)}\n… [共 ${prompt.length} 字]`
        : prompt
      const message = `👤 ${truncated}`

      let originChannel = null
      try {
        originChannel = sessionInputDispatcher?.consumeOrigin?.(sessionId, prompt) || null
      } catch (e) {
        logger.warn?.(`[openclaw-hook] consumeOrigin threw: ${e.message}`)
      }

      try {
        await openclaw?.broadcastEcho?.({ sessionId, message, excludeChannel: originChannel })
      } catch (e) {
        logger.warn?.(`[openclaw-hook] broadcastEcho threw: ${e.message}`)
      }
      return { ok: true, action: 'echoed', origin: originChannel, length: prompt.length }
    }
```

- [ ] **Step 4: Run new tests**

```bash
npx vitest run test/openclaw-hook.test.js -t 'user-prompt-submit'
```

Expected: all five pass.

- [ ] **Step 5: Run the entire openclaw-hook test file to ensure no regression**

```bash
npx vitest run test/openclaw-hook.test.js
```

Expected: green.

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.test.js
git commit -m "$(cat <<'EOF'
feat(hook): handle UserPromptSubmit → broadcast user prompt to IM

Claude / Codex notify.js POSTs event='user-prompt-submit' with
hookPayload.user_prompt (Claude) or hookPayload.prompt (Codex). Handler
truncates at 2000 chars, asks dispatcher.consumeOrigin to find the
origin channel, and fires bridge.broadcastEcho with excludeChannel.

Mobile phone now shows the full conversation no matter which surface
the user typed from.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Task 8: Manual smoke test (no code changes; document outcomes)

**Files:** none (verification only)

- [ ] **Step 1: Restart AgentQuad to trigger hook re-install**

```bash
npm run stop
npm run start
```

Watch the console for `[hook-installer] installed UserPromptSubmit` (or similar) and verify `~/.claude/settings.json` now has a `UserPromptSubmit` hooks entry pointing to `~/.agentquad/claude-hooks/notify.js user-prompt-submit`. Same check for `~/.codex/hooks.json`.

```bash
cat ~/.claude/settings.json | python3 -c 'import json,sys;d=json.load(sys.stdin);print([e for e in d.get("hooks",{}).get("UserPromptSubmit",[])])'
cat ~/.codex/hooks.json | python3 -m json.tool | grep -A2 UserPromptSubmit
```

- [ ] **Step 2: Verify hook.log captures the payload field name**

Pick a todo with an active Claude session, type a one-word prompt (e.g. `ping`) from the PC web UI, hit Enter, and watch the log:

```bash
tail -F ~/.agentquad/claude-hooks/hook.log | grep -i user-prompt-submit
```

Confirm an entry like `{"ts":"...","event":"user-prompt-submit","status":"fired",...}` appears. Then check `~/.agentquad/claude-hooks/` for any captured payload — if not logged, add a one-shot debug `echo "$RAW" >> hook-payload-debug.log` line to `notify.js`, retest, then revert. The goal is to confirm `user_prompt` is the correct field for Claude. Do the same for Codex if there's a Codex session.

If Codex's field name differs (e.g. `prompt` or `message`), the handler already falls back through `user_prompt | prompt | user_message | message` — should still work, but verify by manual test.

- [ ] **Step 3: PC → Telegram + Lark mirror**

Pre-condition: a todo with an active Claude session bound to BOTH a Telegram topic AND a Lark thread. (Use `+create` in either bot if not already bound.)

From the PC web UI, submit `hello from pc`. Within 2 seconds, both:
- Telegram topic shows `👤 hello from pc`
- Lark thread shows `👤 hello from pc`

- [ ] **Step 4: Telegram → Lark only**

From the phone Telegram, type `hello from tg` in the bound topic. Verify:
- Telegram naturally shows your own message (not from bot — your real message)
- The bot does **NOT** post a separate `👤 hello from tg`
- Lark thread receives `👤 hello from tg`

- [ ] **Step 5: Lark → Telegram only**

Symmetric to step 4 from the Lark thread.

- [ ] **Step 6: Long prompt truncation**

Paste 3000 characters into the PC web UI input and submit. Both IM threads should receive `👤 <2000 chars>\n… [共 3000 字]`.

- [ ] **Step 7: Single-bound session**

Find or create a todo bound only to Telegram (no Lark). From PC, submit `solo`. Verify:
- Telegram shows `👤 solo`
- No error in `~/.agentquad/claude-hooks/hook.log` or main process logs

- [ ] **Step 8: Regression check**

Submit a normal message, let Claude reply. Confirm:
- Stop hook still fires, assistant reply still arrives in both IM threads
- SessionEnd → full transcript file attachment still works (close the topic / mark done to trigger)
- No spurious `👤` lines from the bot replying to itself

- [ ] **Step 9: Document findings**

If anything diverged, file a follow-up issue and amend the spec / plan. If Codex `user_prompt` field name needed adjusting, update `src/openclaw-hook.js` field fallback order so the most common Codex field comes first.

- [ ] **Step 10: Final commit if any tweaks were required**

If steps 2–8 required code adjustments, commit them with a fix-up message, then push:

```bash
git push origin main
```

---

## Self-Review Notes

- **Spec coverage**: every component listed in the spec ("File Inventory" mirrors spec §Components 1–5) has at least one task. Manual smoke test covers all verification criteria from spec §Testing.
- **Type consistency**: function names match across tasks (`recordOrigin`, `consumeOrigin`, `broadcastEcho`, `getRoutesForSession`). Argv mapping `user-prompt-submit` is used identically in installers, notify.js argv parsing (already auto-lowercase), and the hook handler switch.
- **Edge cases acknowledged**: mixed-channel queue flush picks last-enqueued channel; rate-limited bridge returns `skipped`; long prompts truncate to 2000 + suffix; Codex payload field unknown → fallback chain.
