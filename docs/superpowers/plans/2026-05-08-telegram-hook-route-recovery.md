# Telegram Hook Route Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore persisted Telegram session routes before sending Claude Code hook pushes so Stop events from routed Telegram sessions are delivered to the correct topic.

**Architecture:** Keep the fix inside the hook handling boundary. When a hook arrives with a `sessionId` but `openclawBridge` has no explicit route, the hook handler will look up the todo's persisted `aiSessions[].telegramRoute`, normalize it to a Telegram route, register it back into the bridge, and then continue the existing send path. Sessions without a persisted route still remain blocked from leaking to Telegram General.

**Tech Stack:** Node.js ESM, Express route handler, better-sqlite3-backed todo store, Vitest.

---

## File Structure

- Modify `test/openclaw-hook.test.js`
  - Add a route-recovery unit test to reproduce the observed `hook fired with no registered route` failure mode.
  - Extend the local fake bridge with `registerSessionRoute()` and dynamic route lookup.
- Modify `src/openclaw-hook.js`
  - Add a small helper that restores a route from `db.getTodo(todoId).aiSessions` when `sessionId` matches.
  - Call the helper before emitting the existing `hook fired with no registered route` warning and before `postText()`.
- Do not modify `src/openclaw-bridge.js`
  - The bridge already has the correct safety behavior: it refuses route-less Telegram session sends instead of leaking to General.
- Do not modify Telegram polling / multi-instance handling in this plan
  - The `getUpdates Conflict` log is a separate risk, not the root cause for this hook push failure.

---

### Task 1: Add a failing route-recovery test

**Files:**
- Modify: `test/openclaw-hook.test.js:10-23`
- Modify: `test/openclaw-hook.test.js:583-597`

- [ ] **Step 1: Update the fake bridge to support route registration**

Replace the existing `makeFakeBridge` helper in `test/openclaw-hook.test.js` with this implementation:

```js
function makeFakeBridge({ sendOk = true, sendReason = null, route = null, explicitRoute = route != null } = {}) {
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
  }
}
```

- [ ] **Step 2: Add the regression test**

Insert this test in the `describe('openclaw-hook handler', ...)` block, immediately before the existing `returns failed when bridge returns not ok` test:

```js
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
```

- [ ] **Step 3: Run the focused test to verify it fails**

Run:

```bash
npx vitest run test/openclaw-hook.test.js -t "restores a persisted Telegram route before sending a Stop hook"
```

Expected result before implementation:

```text
FAIL test/openclaw-hook.test.js > openclaw-hook handler > restores a persisted Telegram route before sending a Stop hook
AssertionError: expected "spy" to be called with arguments: [ 'ai-1778306858264-mgad', ... ]
```

---

### Task 2: Restore persisted Telegram routes in the hook handler

**Files:**
- Modify: `src/openclaw-hook.js:366-391`
- Test: `test/openclaw-hook.test.js`

- [ ] **Step 1: Add route normalization helpers**

In `src/openclaw-hook.js`, insert these helpers immediately after `notifyWebTurnDone()` and before the `handle()` function:

```js
  function normalizePersistedTelegramRoute(route) {
    if (!route?.targetUserId || route.threadId == null) return null
    return {
      ...route,
      targetUserId: String(route.targetUserId),
      channel: route.channel || 'telegram',
    }
  }

  function restorePersistedRoute(sessionId, todoId) {
    if (!sessionId || !todoId || !openclaw?.registerSessionRoute || !db?.getTodo) return false
    if (openclaw.hasExplicitRoute?.(sessionId)) return false
    try {
      const todo = db.getTodo(todoId)
      const aiSession = (todo?.aiSessions || []).find((item) => item?.sessionId === sessionId)
      const route = normalizePersistedTelegramRoute(aiSession?.telegramRoute)
      if (!route) return false
      openclaw.registerSessionRoute(sessionId, route)
      logger.info?.(`[openclaw-hook] restored telegram route for sid=${sessionId} threadId=${route.threadId}`)
      return true
    } catch (e) {
      logger.warn?.(`[openclaw-hook] restore telegram route failed: ${e.message}`)
      return false
    }
  }
```

- [ ] **Step 2: Call restoration before the missing-route warning**

In `src/openclaw-hook.js`, replace the current diagnostic block near the start of `handle()`:

```js
    // 诊断：sessionId 给了但 bridge 没注册过 route → 99% 会触发 telegram fallback / General 泄漏
    // 用 warn 让 race 复现时直接在日志里抓到（A=spawn 抢跑 / B=clear 后尾巴 / D=close handler race）
    if (sessionId && openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      logger.warn?.(`[openclaw-hook] hook fired with no registered route: event=${evt} sid=${sessionId} todoId=${todoId || 'null'}`)
    }
```

with:

```js
    // 诊断：sessionId 给了但 bridge 没注册过 route → 先尝试从 DB 持久化 route 恢复。
    // 恢复失败才 warn；postText 仍会拒绝 route-less Telegram session，避免泄漏到 General。
    if (sessionId && openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      restorePersistedRoute(sessionId, todoId)
    }
    if (sessionId && openclaw?.hasExplicitRoute && !openclaw.hasExplicitRoute(sessionId)) {
      logger.warn?.(`[openclaw-hook] hook fired with no registered route: event=${evt} sid=${sessionId} todoId=${todoId || 'null'}`)
    }
```

- [ ] **Step 3: Run the focused test to verify it passes**

Run:

```bash
npx vitest run test/openclaw-hook.test.js -t "restores a persisted Telegram route before sending a Stop hook"
```

Expected result:

```text
PASS test/openclaw-hook.test.js > openclaw-hook handler > restores a persisted Telegram route before sending a Stop hook
```

---

### Task 3: Verify existing hook behavior is unchanged

**Files:**
- Test: `test/openclaw-hook.test.js`
- Test: `test/openclaw-bridge.test.js`

- [ ] **Step 1: Run the full hook test file**

Run:

```bash
npx vitest run test/openclaw-hook.test.js
```

Expected result:

```text
Test Files  1 passed
Tests       all tests passed
```

If the `fallback Telegram route without explicit session route stays suppressed` test fails, keep its explicit setup intact:

```js
bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 123 }, explicitRoute: false })
```

The route-recovery code should not register anything for that test because the DB contains no matching `telegramRoute`.

- [ ] **Step 2: Run bridge safety tests**

Run:

```bash
npx vitest run test/openclaw-bridge.test.js
```

Expected result:

```text
Test Files  1 passed
Tests       all tests passed
```

This confirms the existing `openclaw-bridge` behavior still refuses route-less Telegram session sends instead of falling back to General.

---

### Task 4: Run targeted integration-adjacent tests

**Files:**
- Test: `test/openclaw-wizard.test.js`
- Test: `test/telegram-loading-status.test.js`
- Test: `test/telegram-sync.test.js`

- [ ] **Step 1: Verify Telegram wizard route persistence still passes**

Run:

```bash
npx vitest run test/openclaw-wizard.test.js
```

Expected result:

```text
Test Files  1 passed
Tests       all tests passed
```

- [ ] **Step 2: Verify loading status still uses registered routes**

Run:

```bash
npx vitest run test/telegram-loading-status.test.js
```

Expected result:

```text
Test Files  1 passed
Tests       all tests passed
```

- [ ] **Step 3: Verify route sync behavior still passes**

Run:

```bash
npx vitest run test/telegram-sync.test.js
```

Expected result:

```text
Test Files  1 passed
Tests       all tests passed
```

---

### Task 5: Full verification

**Files:**
- Test: all repository tests

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected result:

```text
Test Files  all passed
Tests       all passed
```

- [ ] **Step 2: Manual verification with a real Telegram session**

Start or use the running quadtodo service, then create a Telegram todo that starts Claude Code. Confirm these log patterns for the new session:

```text
[wizard] createForumTopic OK threadId=<thread-id>
[loading-status] started sid=<same-session-id> threadId=<thread-id>
```

After Claude Code replies and Stop fires, expected log pattern:

```text
[openclaw-bridge] telegram send sessionId=<same-session-id> chatId=-1003908174749 threadId=<thread-id>
```

There should be no warning for that same session:

```text
[openclaw-hook] hook fired with no registered route: event=stop sid=<same-session-id>
```

Expected Telegram behavior: the Claude Code reply appears in the topic created for that todo, not in General.

---

## Self-Review Notes

- Spec coverage: This plan covers the selected方案 2 by fixing the route registration/recovery path used by hook pushes. It intentionally does not address `getUpdates Conflict` because that is a separate multi-instance polling issue.
- Placeholder scan: No `TBD`, `TODO`, or unspecified test steps remain.
- Type consistency: The route shape matches existing code: `targetUserId`, `threadId`, `topicName`, `channel`. The handler uses existing `db.getTodo()`, `openclaw.hasExplicitRoute()`, and `openclaw.registerSessionRoute()` interfaces.
