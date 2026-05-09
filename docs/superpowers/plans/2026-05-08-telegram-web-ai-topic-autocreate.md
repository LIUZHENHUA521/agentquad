# Telegram Web AI Topic Autocreate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Web “start AI” (`POST /api/ai-terminal/exec`) reliably auto-create a Telegram topic when Telegram topic mirroring is enabled.

**Architecture:** Preserve the existing hook-based design: `createAiTerminal().spawnSession()` calls `onSessionSpawned`, and `server.js` delegates that hook to `openclawWizard.ensureTopicForSession()`. Fix only the confirmed break in that chain, most likely stale Telegram config gating or `supergroupId`/`defaultSupergroupId` mismatch, and keep plain `POST /api/todos` from creating topics.

**Tech Stack:** Node.js ESM, Express, better-sqlite3, Vitest, Supertest, existing Telegram bot wrapper and OpenClaw wizard route registry.

---

## File Structure

- Modify: `test/ai-terminal.route.test.js`
  - Add focused tests that prove `POST /api/ai-terminal/exec` invokes `onSessionSpawned` only when a new session is actually spawned.
- Modify: `test/openclaw-wizard.test.js`
  - Add a regression test that `ensureTopicForSession()` uses `telegram.supergroupId` as the primary configured supergroup, while still preserving the existing fallback to `telegram.defaultSupergroupId` and `allowedChatIds[0]`.
- Modify: `test/server.test.js`
  - Add an integration regression test for the actual Web route: after enabling Telegram via `PUT /api/config`, starting AI should create/register/persist a topic without restarting the server.
- Modify: `src/openclaw-wizard.js`
  - If the failing test confirms chat ID resolution is the break, update `ensureTopicForSession()` to read `telegram.supergroupId` before legacy `telegram.defaultSupergroupId`, then `allowedChatIds[0]`.
- Modify: `src/server.js`
  - If the failing test confirms stale config gating is the break, update `aiSessionHooks.onSessionSpawned` to read current config at hook time instead of using startup-only `initialConfig`.

Do not modify `src/routes/todos.js`: plain todo creation is not in scope and must not create Telegram topics.

---

### Task 1: Prove AI terminal spawn hook behavior

**Files:**
- Modify: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Update the test helper to accept `onSessionSpawned`**

In `test/ai-terminal.route.test.js`, change the `createAiTerminal` call inside `makeApp()` from:

```js
  const ait = createAiTerminal({
    db,
    pty,
    logDir,
    defaultCwd: opts.defaultCwd,
    getWebhookConfig: opts.getWebhookConfig,
    notifier: opts.notifier,
    onSessionEnded: opts.onSessionEnded,
  })
```

to:

```js
  const ait = createAiTerminal({
    db,
    pty,
    logDir,
    defaultCwd: opts.defaultCwd,
    getWebhookConfig: opts.getWebhookConfig,
    notifier: opts.notifier,
    onSessionSpawned: opts.onSessionSpawned,
    onSessionEnded: opts.onSessionEnded,
  })
```

- [ ] **Step 2: Add failing/passing tests for hook invocation semantics**

Add these tests after the existing `POST /exec starts a pty and updates todo` test:

```js
  it('POST /exec invokes onSessionSpawned after starting a new session', async () => {
    const spawned = []
    ctx = makeApp({
      onSessionSpawned: vi.fn((info) => {
        spawned.push(info)
        return null
      }),
    })
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })

    const r = await request(ctx.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hello', tool: 'claude' })

    expect(r.status).toBe(200)
    expect(spawned).toEqual([{ sessionId: r.body.sessionId, todoId: todo.id, tool: 'claude' }])
  })

  it('POST /exec does not invoke onSessionSpawned when reusing an existing native session', async () => {
    const onSessionSpawned = vi.fn(() => null)
    ctx = makeApp({ onSessionSpawned })
    const nativeId = 'abcdef12-3456-7890-abcd-ef1234567890'
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })

    const first = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'first', tool: 'claude', resumeNativeId: nativeId })
    const second = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'second', tool: 'claude', resumeNativeId: nativeId })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(onSessionSpawned).toHaveBeenCalledTimes(1)
    expect(onSessionSpawned).toHaveBeenCalledWith({ sessionId: first.body.sessionId, todoId: todo.id, tool: 'claude' })
  })
```

- [ ] **Step 3: Run the focused tests**

Run:

```bash
npm test -- test/ai-terminal.route.test.js -t "onSessionSpawned|reusing an existing native session"
```

Expected:
- These tests should pass if `src/routes/ai-terminal.js:387-393` is already correct.
- If they fail, fix `spawnSession()` so `onSessionSpawned({ sessionId, todoId, tool })` runs after `pty.start()` only when `reused: false`, and keep `skipTelegram` respected.

- [ ] **Step 4: If needed, minimally fix `src/routes/ai-terminal.js`**

Only if Step 3 fails because the hook is missing or has the wrong payload, ensure this block remains after `pty.start()` and before `return { sessionId, reused: false }`:

```js
    if (!skipTelegram && typeof onSessionSpawned === 'function') {
      try {
        const r = onSessionSpawned({ sessionId, todoId, tool })
        if (r && typeof r.catch === 'function') r.catch((e) => console.warn(`[ai-terminal] onSessionSpawned failed: ${e.message}`))
      } catch (e) { console.warn(`[ai-terminal] onSessionSpawned threw: ${e.message}`) }
    }
```

- [ ] **Step 5: Re-run the focused tests**

Run:

```bash
npm test -- test/ai-terminal.route.test.js -t "onSessionSpawned|reusing an existing native session"
```

Expected: PASS.

---

### Task 2: Fix Telegram chat ID resolution for topic creation

**Files:**
- Modify: `test/openclaw-wizard.test.js`
- Modify: `src/openclaw-wizard.js`

- [ ] **Step 1: Add a regression test for `telegram.supergroupId`**

In `test/openclaw-wizard.test.js`, add this test near the existing `ensureTopicForSession` tests:

```js
  it('ensureTopicForSession: uses telegram.supergroupId before legacy defaultSupergroupId and allowedChatIds', async () => {
    const todo = db.createTodo({ title: 'supergroup-primary', quadrant: 2, workDir: '/tmp' })
    db.updateTodo(todo.id, {
      aiSessions: [{ sessionId: 'sid-supergroup', tool: 'claude', status: 'running', startedAt: Date.now() }],
    })
    const fakeTelegramBot = {
      createForumTopic: vi.fn(async ({ chatId, name }) => ({ message_thread_id: 444, name, chatId })),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    }
    bridge.resolveRoute = (sid) => bridge.routes.get(sid) || null

    const w2 = createOpenClawWizard({
      db, aiTerminal: ai, openclaw: bridge, pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({
        telegram: {
          supergroupId: '-100-primary',
          defaultSupergroupId: '-100-legacy',
          allowedChatIds: ['-100-allowed'],
        },
      }),
    })

    const r = await w2.ensureTopicForSession({ sessionId: 'sid-supergroup', todoId: todo.id })

    expect(r.ok).toBe(true)
    expect(fakeTelegramBot.createForumTopic).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '-100-primary',
    }))
    expect(bridge.routes.get('sid-supergroup')).toMatchObject({
      targetUserId: '-100-primary',
      threadId: 444,
      channel: 'telegram',
    })
    const persisted = db.getTodo(todo.id).aiSessions.find((s) => s.sessionId === 'sid-supergroup')
    expect(persisted.telegramRoute).toMatchObject({ targetUserId: '-100-primary', threadId: 444 })
  })
```

- [ ] **Step 2: Run the new test and confirm failure**

Run:

```bash
npm test -- test/openclaw-wizard.test.js -t "uses telegram.supergroupId"
```

Expected before fix: FAIL because `ensureTopicForSession()` currently ignores `telegram.supergroupId` and prefers `defaultSupergroupId` or `allowedChatIds[0]`.

- [ ] **Step 3: Implement the minimal chat ID resolution fix**

In `src/openclaw-wizard.js`, inside `ensureTopicForSession()`, replace:

```js
    // 决定 chatId：优先 telegram.defaultSupergroupId，回退 allowedChatIds[0]
    const cfg = getConfig?.() || {}
    const tg = cfg.telegram || {}
    const chatId = tg.defaultSupergroupId || (Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds[0] : null)
```

with:

```js
    // 决定 chatId：优先当前配置字段，兼容 legacy defaultSupergroupId，最后回退 allowedChatIds[0]
    const cfg = getConfig?.() || {}
    const tg = cfg.telegram || {}
    const chatId = tg.supergroupId || tg.defaultSupergroupId || (Array.isArray(tg.allowedChatIds) ? tg.allowedChatIds[0] : null)
```

Do not change any other behavior in `ensureTopicForSession()`.

- [ ] **Step 4: Re-run the focused wizard tests**

Run:

```bash
npm test -- test/openclaw-wizard.test.js -t "ensureTopicForSession"
```

Expected: PASS, including existing fallback/idempotency tests.

---

### Task 3: Fix runtime config gating for Web start-AI auto topic creation

**Files:**
- Modify: `test/server.test.js`
- Modify: `src/server.js`

- [ ] **Step 1: Add a Telegram bot mock to server tests**

At the top of `test/server.test.js`, after the existing `larkBotMockState` and `vi.mock('../src/lark-bot.js', ...)` block, add a Telegram mock state and mock:

```js
const telegramBotMockState = vi.hoisted(() => ({
  instances: [],
  nextBot: null,
}))

vi.mock('../src/telegram-bot.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createTelegramBot: vi.fn(() => {
      const bot = telegramBotMockState.nextBot || {
        start: vi.fn(() => {}),
        stop: vi.fn(async () => ({ ok: true })),
        createForumTopic: vi.fn(async ({ name }) => ({ message_thread_id: 909, name })),
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        setMyCommands: vi.fn(async () => true),
        setProbeListener: vi.fn(() => {}),
      }
      telegramBotMockState.nextBot = null
      telegramBotMockState.instances.push(bot)
      return bot
    }),
  }
})
```

In the `beforeEach()` block, reset the Telegram mock state alongside Lark:

```js
    telegramBotMockState.instances = []
    telegramBotMockState.nextBot = null
```

- [ ] **Step 2: Add an integration regression test for config hot-update plus Web start AI**

Add this test near the existing config tests in `test/server.test.js`:

```js
  it('creates a Telegram topic for Web-started AI after Telegram is enabled via config update', async () => {
    const update = await request(srv.app)
      .put('/api/config')
      .send({
        telegram: {
          enabled: true,
          supergroupId: '-100-web-ai',
          allowedChatIds: ['-100-web-ai'],
          autoCreateTopic: true,
        },
      })

    expect(update.status).toBe(200)
    expect(update.body.telegramRestart).toMatchObject({ applied: true })
    const bot = telegramBotMockState.instances.at(-1)
    expect(bot).toBeTruthy()

    const todo = srv.db.createTodo({ title: 'Web AI topic', quadrant: 1, workDir: workRootDir })
    const exec = await request(srv.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })

    expect(exec.status).toBe(200)
    await vi.waitFor(() => expect(bot.createForumTopic).toHaveBeenCalledTimes(1))
    expect(bot.createForumTopic).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '-100-web-ai',
      name: expect.stringContaining('Web AI topic'),
    }))

    const route = srv.openclawBridge.resolveRoute(exec.body.sessionId)
    expect(route).toMatchObject({
      targetUserId: '-100-web-ai',
      threadId: 909,
      channel: 'telegram',
    })
    const updatedTodo = srv.db.getTodo(todo.id)
    expect(updatedTodo.aiSessions[0].telegramRoute).toMatchObject({
      targetUserId: '-100-web-ai',
      threadId: 909,
      channel: 'telegram',
    })
    expect(bot.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '-100-web-ai',
      threadId: 909,
      text: expect.stringContaining('自动镜像 from web/CLI'),
    }))
  })
```

- [ ] **Step 3: Run the new integration test and confirm failure**

Run:

```bash
npm test -- test/server.test.js -t "creates a Telegram topic for Web-started AI"
```

Expected before fix: FAIL if `src/server.js` still gates `onSessionSpawned` using startup-only `initialConfig`, because the server started with Telegram disabled and the hook remains disabled even after `PUT /api/config` restarts Telegram.

- [ ] **Step 4: Implement runtime config gating fix**

In `src/server.js`, replace this block:

```js
		// ─── Telegram 自动 topic 镜像（B 方案）─────────────────────────
		// 默认开；config.telegram.autoCreateTopic = false 可关
		const telegramConfig = (initialConfig?.telegram) || {}
		const autoCreateEnabled = telegramConfig.enabled && telegramConfig.autoCreateTopic !== false
		aiSessionHooks.onSessionSpawned = ({ sessionId, todoId }) => {
			if (!autoCreateEnabled) return null
			return openclawWizard.ensureTopicForSession({ sessionId, todoId })
				.catch((e) => console.warn(`[server] ensureTopicForSession failed: ${e.message}`))
		}
```

with:

```js
		// ─── Telegram 自动 topic 镜像（B 方案）─────────────────────────
		// 默认开；config.telegram.autoCreateTopic = false 可关。这里必须读实时配置，
		// 因为设置页会热启用 Telegram，不应要求重启 quadtodo 才生效。
		aiSessionHooks.onSessionSpawned = ({ sessionId, todoId }) => {
			const telegramConfig = loadConfig({ rootDir: configRootDir }).telegram || {}
			const autoCreateEnabled = telegramConfig.enabled && telegramConfig.autoCreateTopic !== false
			if (!autoCreateEnabled) return null
			return openclawWizard.ensureTopicForSession({ sessionId, todoId })
				.catch((e) => console.warn(`[server] ensureTopicForSession failed: ${e.message}`))
		}
```

Keep `onSessionEnded` unchanged unless a test proves it has the same stale-config problem for auto-close. This task is about Web-started AI topic creation only.

- [ ] **Step 5: Re-run the integration test**

Run:

```bash
npm test -- test/server.test.js -t "creates a Telegram topic for Web-started AI"
```

Expected: PASS.

---

### Task 4: Verify disabled and wizard paths remain unchanged

**Files:**
- Modify: `test/server.test.js`
- Test existing: `test/openclaw-wizard.test.js`

- [ ] **Step 1: Add an integration test for `autoCreateTopic=false`**

Add this test in `test/server.test.js` after the Web-started AI topic test:

```js
  it('does not create a Telegram topic for Web-started AI when autoCreateTopic is false', async () => {
    await request(srv.app)
      .put('/api/config')
      .send({
        telegram: {
          enabled: true,
          supergroupId: '-100-web-ai',
          allowedChatIds: ['-100-web-ai'],
          autoCreateTopic: false,
        },
      })

    const bot = telegramBotMockState.instances.at(-1)
    expect(bot).toBeTruthy()

    const todo = srv.db.createTodo({ title: 'No topic', quadrant: 1, workDir: workRootDir })
    const exec = await request(srv.app)
      .post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })

    expect(exec.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bot.createForumTopic).not.toHaveBeenCalled()
    expect(srv.openclawBridge.resolveRoute(exec.body.sessionId)).toBeNull()
    const updatedTodo = srv.db.getTodo(todo.id)
    expect(updatedTodo.aiSessions[0]).not.toHaveProperty('telegramRoute')
  })
```

- [ ] **Step 2: Run the disabled-path test**

Run:

```bash
npm test -- test/server.test.js -t "autoCreateTopic is false"
```

Expected: PASS.

- [ ] **Step 3: Re-run existing Telegram wizard topic tests**

Run:

```bash
npm test -- test/openclaw-wizard.test.js -t "Telegram: finalizeWizard creates Topic|Telegram: finalizeWizard persists telegramRoute"
```

Expected: PASS. These prove the wizard-managed path still creates exactly one topic through `skipTelegram: true` and persists the route.

---

### Task 5: Final verification

**Files:**
- No additional code changes expected.

- [ ] **Step 1: Run all directly affected test files**

Run:

```bash
npm test -- test/ai-terminal.route.test.js test/openclaw-wizard.test.js test/server.test.js test/telegram-sync.test.js
```

Expected: PASS.

- [ ] **Step 2: Run full test suite if focused tests pass**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Manual verification in local app if credentials are available**

If the local Telegram bot token and supergroup are configured, start the app and verify the real Web flow:

```bash
npm run start
```

Manual steps:
1. Open the Web UI.
2. Create or select a todo.
3. Click “开始 AI”.
4. Confirm a Telegram topic appears in the configured supergroup.
5. Confirm the topic receives the welcome text containing `自动镜像 from web/CLI`.
6. Confirm the todo’s latest AI session has a persisted `telegramRoute.threadId` by checking the Web UI state or querying the API if needed.

Expected: A new topic is created and AI session output routes there.

- [ ] **Step 4: Report results**

Include:
- Root cause found.
- Files changed.
- Tests run and pass/fail status.
- Whether real Telegram manual verification was performed.
- Any remaining user decision, especially if Telegram API permissions or credentials prevented manual verification.

---

## Self-Review

- Spec coverage: The plan covers the confirmed B path: Web todo + start AI, not plain todo creation. It also preserves wizard behavior and disabled auto-create behavior.
- Placeholder scan: No TBD/TODO/later placeholders remain. All code changes and commands are explicit.
- Type consistency: Existing names are used consistently: `onSessionSpawned`, `ensureTopicForSession`, `supergroupId`, `defaultSupergroupId`, `allowedChatIds`, `telegramRoute`, `openclawBridge.resolveRoute()`.
