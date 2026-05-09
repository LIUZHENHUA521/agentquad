# Remove Webhook Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove webhook notification sending and settings UI while preserving legacy config compatibility and keeping pending-confirm AI terminal behavior.

**Architecture:** Keep pending-confirm detection as local AI terminal behavior and remove the webhook-oriented notifier boundary. Preserve the backend `webhook` config shape as a legacy tolerated field, but stop frontend reads/writes and stop all runtime webhook sends.

**Tech Stack:** Node.js ESM, Express, Vitest, React, TypeScript, Ant Design, Vite.

---

## Implementation Rules

- Do not create a git commit unless the user explicitly asks for one.
- Make surgical changes only for webhook removal.
- Keep `pending_confirm` status behavior intact.
- Do not send real network requests in tests.

## File Map

- Modify `src/routes/ai-terminal.js`
  - Remove `createNotifier` import and dependency injection.
  - Add local confirm-prompt detection helper.
  - Remove webhook and keyword notification sending from PTY output handling.
- Modify `src/server.js`
  - Stop carrying webhook runtime config into AI terminal.
- Delete `src/notifier.js`
  - Remove obsolete webhook payload, cooldown, keyword, and POST logic.
- Modify `test/ai-terminal.route.test.js`
  - Remove notifier injection scaffolding.
  - Add regression coverage that keyword-like output does not call `fetch` even with legacy webhook config.
  - Keep coverage that confirm prompts still mark sessions/todos as pending.
- Modify `test/config.test.js`
  - Rename the webhook config test to make legacy compatibility explicit.
- Modify `web/src/SettingsDrawer.tsx`
  - Remove webhook form load/save and JSX controls.
- Modify `web/src/api.ts`
  - Mark `AppConfig.webhook` optional legacy data, or remove frontend dependency entirely. Preferred: optional legacy field to match `/api/config` compatibility.
- Modify `README.md`
  - Remove Feishu/WeCom webhook wording from the future notification notes.

---

### Task 1: Add failing backend regression tests

**Files:**
- Modify: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Update `makeApp` so tests no longer treat notifier injection as normal app setup**

In `test/ai-terminal.route.test.js`, replace the `createAiTerminal` call inside `makeApp` with this version:

```js
  const ait = createAiTerminal({
    db,
    pty,
    logDir,
    defaultCwd: opts.defaultCwd,
    getWebhookConfig: opts.getWebhookConfig,
    onSessionEnded: opts.onSessionEnded,
  })
```

This keeps `getWebhookConfig` temporarily available for the failing regression test. It will become an ignored legacy option after implementation.

- [ ] **Step 2: Replace the confirm notification test with pending-confirm behavior coverage**

Replace the test named `confirm-like output marks todo as ai_pending and notifies` with:

```js
  it('confirm-like output marks todo as ai_pending and broadcasts pending_confirm', async () => {
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.pty.emit('output', { sessionId: body.sessionId, data: 'Press Enter to confirm' })

    const updated = ctx.db.getTodo(todo.id)
    expect(updated.status).toBe('ai_pending')
    expect(updated.aiSession.status).toBe('pending_confirm')
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'pending_confirm',
      matchedKeyword: 'Press Enter to confirm',
    }))
  })
```

- [ ] **Step 3: Add a failing test that legacy webhook config does not trigger keyword webhook sends**

Add this test immediately after the confirm-like output test:

```js
  it('keyword-like output does not send webhook notifications from legacy config', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true })
    try {
      ctx = makeApp({
        getWebhookConfig: () => ({
          enabled: true,
          provider: 'wecom',
          url: 'https://example.test/webhook',
          keywords: ['WAKE_ME'],
          cooldownMs: 1,
          notifyOnPendingConfirm: true,
          notifyOnKeywordMatch: true,
        }),
      })
      const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
      const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
        .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })

      ctx.pty.emit('output', { sessionId: body.sessionId, data: 'WAKE_ME' })
      await new Promise(resolve => setImmediate(resolve))

      expect(fetchSpy).not.toHaveBeenCalled()
      expect(ctx.ait.sessions.get(body.sessionId).status).toBe('running')
    } finally {
      fetchSpy.mockRestore()
    }
  })
```

Expected before implementation: this test fails because current notifier keyword matching calls `fetch`.

- [ ] **Step 4: Remove notifier injection from pending-confirm lifecycle tests**

For the tests named:

- `resize applies while session is pending_confirm`
- `user input clears pending_confirm state and broadcasts pending_cleared`
- `pending_confirm can re-trigger after user has cleared it`
- `non-decisive keystrokes do not clear pending_confirm (avoid border-width jitter on every keypress)`

Replace setup blocks like this:

```js
    ctx = makeApp({
      notifier: {
        detectConfirmMatch: () => 'Press Enter to confirm',
        detectKeywordMatch: () => null,
        canNotifyPendingConfirm: () => false,
        notify: vi.fn(),
      },
      getWebhookConfig: () => ({ enabled: true }),
    })
```

with:

```js
    ctx = makeApp()
```

Keep each test's emitted output as `Press Enter to confirm` so the local detector can recognize it.

- [ ] **Step 5: Run focused backend tests and confirm the new regression fails**

Run:

```bash
npm test -- test/ai-terminal.route.test.js
```

Expected: FAIL on `keyword-like output does not send webhook notifications from legacy config` with `fetchSpy` called at least once. Other updated pending-confirm tests should still pass or only fail because implementation has not removed notifier arguments yet.

---

### Task 2: Remove backend webhook runtime sending

**Files:**
- Modify: `src/routes/ai-terminal.js`
- Modify: `src/server.js`
- Delete: `src/notifier.js`
- Test: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Replace notifier import with local confirm patterns**

In `src/routes/ai-terminal.js`, delete:

```js
import { createNotifier } from '../notifier.js'
```

Add this block after the existing constants:

```js
const DEFAULT_CONFIRM_PATTERNS = [
  /Press Enter to confirm/i,
  /Do you want to proceed/i,
  /Do you want to /i,
  /Continue\?/i,
  /Proceed\?/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /确认/i,
  /是否继续/i,
  /按回车确认/i,
]

function compactTerminalText(text = '') {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function detectConfirmMatch(text) {
  const haystack = compactTerminalText(text)
  if (!haystack) return null
  for (const pattern of DEFAULT_CONFIRM_PATTERNS) {
    if (pattern.test(haystack)) return pattern.source
  }
  return null
}
```

- [ ] **Step 2: Remove webhook parameters from `createAiTerminal`**

Change the function signature in `src/routes/ai-terminal.js` from:

```js
export function createAiTerminal({ db, pty, logDir, defaultCwd, getDefaultCwd, getWebhookConfig, notifier: injectedNotifier, onSessionSpawned = null, onSessionEnded = null }) {
```

to:

```js
export function createAiTerminal({ db, pty, logDir, defaultCwd, getDefaultCwd, onSessionSpawned = null, onSessionEnded = null }) {
```

Delete this line:

```js
  const notifier = injectedNotifier || createNotifier({ getWebhookConfig })
```

- [ ] **Step 3: Remove webhook and keyword notification branches from PTY output handling**

In `src/routes/ai-terminal.js`, replace the output handling block that starts with:

```js
    const confirmMatch = notifier.detectConfirmMatch(session.recentOutput)
```

and ends just before:

```js
    broadcastToSession(session, { type: 'output', data })
```

with:

```js
    const confirmMatch = detectConfirmMatch(session.recentOutput)
    if (confirmMatch && session.status !== 'pending_confirm') {
      session.status = 'pending_confirm'
      const todo = db.getTodo(session.todoId)
      if (todo) {
        const current = (todo.aiSessions || []).find(item => item.sessionId === sessionId) || todo.aiSession || {}
        db.updateTodo(session.todoId, {
          status: 'ai_pending',
          aiSessions: mergeTodoAiSessions(todo, {
            ...current,
            sessionId: session.sessionId,
            tool: session.tool,
            nativeSessionId: session.nativeSessionId || current.nativeSessionId || null,
            status: 'pending_confirm',
            startedAt: session.startedAt,
            completedAt: null,
            prompt: session.prompt,
          }),
        })
      }
      const snippet = session.recentOutput.slice(-500)
      broadcastToSession(session, { type: 'pending_confirm', snippet, matchedKeyword: confirmMatch })
    }
```

This intentionally removes:

```js
notifier.canNotifyPendingConfirm()
notifier.notify(...)
notifier.detectKeywordMatch(...)
console.warn('[ai-terminal] pending_confirm webhook failed:', ...)
console.warn('[ai-terminal] keyword webhook failed:', ...)
```

- [ ] **Step 4: Stop passing webhook runtime config from the server**

In `src/server.js`, remove this property from `runtimeConfig`:

```js
      webhook: initialConfig?.webhook || null,
```

Remove this property from the `createAiTerminal` call:

```js
      getWebhookConfig: () => runtimeConfig.webhook,
```

Remove this runtime update after saving config:

```js
      runtimeConfig.webhook = next.webhook || runtimeConfig.webhook;
```

Do not remove webhook normalization from `src/config.js`; it is legacy compatibility.

- [ ] **Step 5: Delete obsolete notifier file**

Delete:

```bash
src/notifier.js
```

Use a normal file deletion through the editing tool or shell. Do not delete any other files.

- [ ] **Step 6: Run focused backend tests**

Run:

```bash
npm test -- test/ai-terminal.route.test.js
```

Expected: PASS. The keyword regression test should now pass because no code calls `fetch` for legacy webhook config.

---

### Task 3: Keep legacy webhook config compatibility explicit

**Files:**
- Modify: `test/config.test.js`
- Verify: `src/config.js`

- [ ] **Step 1: Rename the legacy config test**

In `test/config.test.js`, change:

```js
  it("loadConfig normalizes webhook config shape", async () => {
```

to:

```js
  it("loadConfig preserves legacy webhook config compatibility", async () => {
```

Keep the test body unchanged:

```js
    writeFileSync(
      join(tmpRoot, "config.json"),
      JSON.stringify({
        port: 5677,
        defaultTool: "claude",
        defaultCwd: "/tmp",
        tools: {},
        webhook: {
          enabled: true,
          provider: "feishu",
          url: "https://example.com",
          keywords: ["hello", " world "],
        },
      }),
    );
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({ rootDir: tmpRoot });
    expect(cfg.webhook.enabled).toBe(true);
    expect(cfg.webhook.provider).toBe("feishu");
    expect(cfg.webhook.cooldownMs).toBeGreaterThan(0);
    expect(cfg.webhook.keywords).toEqual(["hello", "world"]);
```

- [ ] **Step 2: Verify config tests pass**

Run:

```bash
npm test -- test/config.test.js
```

Expected: PASS. This confirms old config files with `webhook` still load.

---

### Task 4: Remove webhook settings UI and frontend dependency

**Files:**
- Modify: `web/src/SettingsDrawer.tsx`
- Modify: `web/src/api.ts`

- [ ] **Step 1: Stop loading webhook values into the settings form**

In `web/src/SettingsDrawer.tsx`, remove these properties from the `form.setFieldsValue` call in the `useEffect` that loads `getConfig()`:

```ts
          webhookEnabled: result.config.webhook.enabled,
          webhookProvider: result.config.webhook.provider,
          webhookUrl: result.config.webhook.url,
          webhookKeywords: result.config.webhook.keywords.join('\n'),
          webhookCooldownMs: result.config.webhook.cooldownMs,
          notifyOnPendingConfirm: result.config.webhook.notifyOnPendingConfirm,
          notifyOnKeywordMatch: result.config.webhook.notifyOnKeywordMatch,
```

- [ ] **Step 2: Stop saving webhook config from the settings form**

In `web/src/SettingsDrawer.tsx`, remove this object from the `updateConfig({ ... })` payload in `handleSave`:

```ts
        webhook: {
          enabled: Boolean(values.webhookEnabled),
          provider: values.webhookProvider || 'wecom',
          url: values.webhookUrl || '',
          keywords: String(values.webhookKeywords || '')
            .split('\n')
            .map((item: string) => item.trim())
            .filter(Boolean),
          cooldownMs: Number(values.webhookCooldownMs) || 180000,
          notifyOnPendingConfirm: values.notifyOnPendingConfirm !== false,
          notifyOnKeywordMatch: values.notifyOnKeywordMatch !== false,
        },
```

The surrounding payload should go directly from `tools: { ... }` to `telegram: { ... }`.

- [ ] **Step 3: Remove the Webhook notification JSX section**

In `web/src/SettingsDrawer.tsx`, delete the JSX block from:

```tsx
        <Paragraph style={{ marginTop: 24, marginBottom: 12 }}>
          <Text strong>Webhook 通知</Text>
        </Paragraph>
```

through:

```tsx
        <Form.Item
          name="webhookCooldownMs"
          label="通知节流毫秒数"
          extra="同一会话在这个时间窗口内不会重复推送相同原因。"
        >
          <Input type="number" min={1000} step={1000} />
        </Form.Item>
```

After deletion, the next section should be:

```tsx
        <Paragraph style={{ marginTop: 24, marginBottom: 12 }}>
          <Text strong>通知渠道</Text>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            Telegram 和 Lark / 飞书的双向通知配置。
          </Text>
        </Paragraph>
```

- [ ] **Step 4: Make webhook optional legacy data in the API type**

In `web/src/api.ts`, change the `AppConfig` webhook field from:

```ts
  webhook: {
    enabled: boolean
    provider: 'wecom' | 'feishu'
    url: string
    keywords: string[]
    cooldownMs: number
    notifyOnPendingConfirm: boolean
    notifyOnKeywordMatch: boolean
  }
```

to:

```ts
  webhook?: {
    enabled: boolean
    provider: 'wecom' | 'feishu'
    url: string
    keywords: string[]
    cooldownMs: number
    notifyOnPendingConfirm: boolean
    notifyOnKeywordMatch: boolean
  }
```

This keeps `/api/config` compatibility without making the settings UI depend on the legacy field.

- [ ] **Step 5: Run frontend type/build verification**

Run:

```bash
npm run build:web
```

Expected: PASS. TypeScript should report no `webhook` property access errors.

---

### Task 5: Update documentation wording

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Remove Feishu/WeCom webhook wording**

In `README.md`, replace:

```md
    - pending_confirm 状态触发 macOS 原生通知（不用只靠飞书/企微 webhook）
```

with:

```md
    - pending_confirm 状态触发 macOS 原生通知
```

- [ ] **Step 2: Search for remaining user-facing webhook references**

Run:

```bash
grep -R "Webhook\|webhook\|企微 webhook\|飞书/企微" -n README.md web/src src test --exclude-dir=node_modules
```

Expected: only intentional legacy config test/config code references remain. There should be no settings UI or runtime notifier references.

---

### Task 6: Full verification and UI check

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run backend test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
npm run build:web
```

Expected: PASS.

- [ ] **Step 3: Static check that webhook sender is gone**

Run:

```bash
grep -R "postWebhook\|createNotifier\|webhook failed\|notifyOnKeywordMatch\|Webhook 通知" -n src web/src test README.md --exclude-dir=node_modules
```

Expected: no output for runtime sender/UI strings. If `notifyOnKeywordMatch` appears only inside the legacy config compatibility test or optional legacy API type, that is acceptable.

- [ ] **Step 4: Start the web app for manual UI verification**

Run:

```bash
npm start
```

Expected: server starts and serves the app. If the port is already in use, use the existing running quadtodo instance instead of killing processes without user confirmation.

- [ ] **Step 5: Browser-check settings drawer**

Open the app in a browser and check the settings drawer.

Expected:

- The settings drawer opens.
- There is no `Webhook 通知` section.
- There is no `Webhook 地址` field.
- Telegram and Lark notification settings are still visible.
- Saving settings succeeds without sending a `webhook` field from the frontend request payload.

Use Playwright browser automation for this check if available in the session.

- [ ] **Step 6: Summarize results**

Report:

- changed files,
- webhook sender/UI removal summary,
- test commands and pass/fail results,
- browser verification result,
- any remaining legacy `webhook` references and why they remain.
