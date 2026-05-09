# Telegram Permission Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram-created Claude Code sessions use a configurable permission mode and send conservative Telegram approval buttons when non-bypass sessions appear to be waiting for authorization.

**Architecture:** Add `telegram.defaultPermissionMode` as a normalized server-side config field with default `bypass`, then route Telegram wizard create/reopen through that value instead of hard-coded bypass. Add a small approval-callback path that sends PTY key presses (`Enter` / `Esc`) from Telegram inline buttons, and make the hook handler attach those buttons only for routed Telegram sessions whose permission mode is not `bypass`.

**Tech Stack:** Node.js ES modules, Express, Vitest, React + Ant Design settings UI, Telegram Bot API inline keyboards.

---

## File Structure

- Modify `src/config.js`
  - Owns default config and normalization.
  - Add `telegram.defaultPermissionMode` defaulting to `bypass`.
  - Normalize invalid legacy/user values back to `bypass`.

- Modify `test/config.test.js`
  - Covers legacy config normalization and invalid `defaultPermissionMode` fallback.

- Modify `src/routes/ai-terminal.js`
  - Preserve each spawned session's effective `permissionMode` in the in-memory session object so hook handling can distinguish `default`, `acceptEdits`, and `bypass`.

- Modify `src/openclaw-wizard.js`
  - Use `cfg.telegram.defaultPermissionMode` for Telegram wizard create and reopen.
  - Add callback handling for `qt:perm:<sessionShort>:allow|deny` buttons.
  - Keep existing ask_user and wizard callbacks unchanged.

- Modify `src/openclaw-hook.js`
  - Detect whether a routed Telegram session is non-bypass.
  - Do not suppress notification events by default for non-bypass Telegram sessions.
  - Attach conservative permission buttons to notification messages for non-bypass Telegram sessions.

- Modify `test/openclaw-wizard.test.js`
  - Covers default bypass, configured `default`, configured `acceptEdits`, reopen propagation, and permission button callbacks writing `Enter`/`Esc` to PTY.

- Modify `test/openclaw-hook.test.js`
  - Covers non-bypass notification not being suppressed, bypass notification still suppressed, and reply markup shape for approval buttons.

- Modify `web/src/api.ts`
  - Add the optional TypeScript field for `telegram.defaultPermissionMode`.

- Modify `web/src/SettingsDrawer.tsx`
  - Add a Telegram settings radio group for `default | acceptEdits | bypass`.
  - Read and save the value through `/api/config`.

---

### Task 1: Add Telegram permission-mode config

**Files:**
- Modify: `src/config.js:70-86`, `src/config.js:333-342`
- Test: `test/config.test.js:217-227`

- [ ] **Step 1: Write the failing config tests**

Append these tests inside `test/config.test.js`, replacing the current `describe('telegram defaults: pollRetryDelayMs / minRenameIntervalMs', ...)` block with this expanded block:

```js
describe('telegram defaults', () => {
	it('normalizes legacy config without Telegram runtime fields by injecting defaults', async () => {
		const { loadConfig } = await import('../src/config.js');
		const tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-'));
		writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { enabled: true } }));
		const cfg = loadConfig({ rootDir: tmp });
		expect(cfg.telegram.pollRetryDelayMs).toBe(5000);
		expect(cfg.telegram.minRenameIntervalMs).toBe(30000);
		expect(cfg.telegram.defaultPermissionMode).toBe('bypass');
		rmSync(tmp, { recursive: true, force: true });
	});

	it('keeps valid telegram.defaultPermissionMode values', async () => {
		const { loadConfig } = await import('../src/config.js');
		const tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-'));
		writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { defaultPermissionMode: 'acceptEdits' } }));
		const cfg = loadConfig({ rootDir: tmp });
		expect(cfg.telegram.defaultPermissionMode).toBe('acceptEdits');
		rmSync(tmp, { recursive: true, force: true });
	});

	it('falls back invalid telegram.defaultPermissionMode to bypass', async () => {
		const { loadConfig } = await import('../src/config.js');
		const tmp = mkdtempSync(join(tmpdir(), 'qt-cfg-'));
		writeFileSync(join(tmp, 'config.json'), JSON.stringify({ telegram: { defaultPermissionMode: 'yolo' } }));
		const cfg = loadConfig({ rootDir: tmp });
		expect(cfg.telegram.defaultPermissionMode).toBe('bypass');
		rmSync(tmp, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Run config tests to verify failure**

Run:

```bash
npm test -- test/config.test.js
```

Expected: FAIL because `cfg.telegram.defaultPermissionMode` is `undefined` or invalid values are not normalized.

- [ ] **Step 3: Implement config default and normalization**

In `src/config.js`, add this constant near `SUPPORTED_TOOLS`:

```js
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypass']);

function normalizePermissionMode(value, fallback = 'bypass') {
	return PERMISSION_MODES.has(value) ? value : fallback;
}
```

Add this field to `DEFAULT_TELEGRAM_CONFIG`:

```js
		defaultPermissionMode: 'bypass',
```

Update the `telegram` object returned by `normalizeConfig` to include normalized permission mode after `allowedFromUserIds`:

```js
			telegram: {
				...DEFAULT_TELEGRAM_CONFIG,
				...(cfg.telegram || {}),
				allowedChatIds: Array.isArray(cfg.telegram?.allowedChatIds)
					? cfg.telegram.allowedChatIds.map((x) => String(x).trim()).filter(Boolean)
					: [...DEFAULT_TELEGRAM_CONFIG.allowedChatIds],
				allowedFromUserIds: Array.isArray(cfg.telegram?.allowedFromUserIds)
					? cfg.telegram.allowedFromUserIds.map((x) => String(x).trim()).filter(Boolean)
					: [...DEFAULT_TELEGRAM_CONFIG.allowedFromUserIds],
				defaultPermissionMode: normalizePermissionMode(cfg.telegram?.defaultPermissionMode),
			},
```

- [ ] **Step 4: Run config tests to verify pass**

Run:

```bash
npm test -- test/config.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(telegram): add default permission mode config"
```

---

### Task 2: Use Telegram permission mode when spawning sessions

**Files:**
- Modify: `src/routes/ai-terminal.js:261-279`
- Modify: `src/openclaw-wizard.js:593-604`, `src/openclaw-wizard.js:869-880`
- Test: `test/openclaw-wizard.test.js:160-172`

- [ ] **Step 1: Write failing wizard spawn tests**

In `test/openclaw-wizard.test.js`, after the existing test `one-shot create skips all wizard steps`, add:

```js
  it('one-shot create uses configured telegram.defaultPermissionMode', async () => {
    const localAi = makeFakeAi()
    const localWizard = createOpenClawWizard({
      db, aiTerminal: localAi, openclaw: bridge, pending,
      getConfig: () => ({
        defaultCwd: '/tmp',
        port: 5677,
        defaultTool: 'claude',
        telegram: { defaultPermissionMode: 'default' },
      }),
    })

    const r = await localWizard.handleInbound({
      peer: 'u1',
      text: '帮我做 修复 login，目录 /tmp/foo, 象限 1, Bug 修复 模板',
    })

    expect(r.action).toBe('wizard_done')
    expect(localAi.sessions).toHaveLength(1)
    expect(localAi.sessions[0].permissionMode).toBe('default')
  })

  it('one-shot create supports acceptEdits telegram.defaultPermissionMode', async () => {
    const localAi = makeFakeAi()
    const localWizard = createOpenClawWizard({
      db, aiTerminal: localAi, openclaw: bridge, pending,
      getConfig: () => ({
        defaultCwd: '/tmp',
        port: 5677,
        defaultTool: 'claude',
        telegram: { defaultPermissionMode: 'acceptEdits' },
      }),
    })

    const r = await localWizard.handleInbound({
      peer: 'u1',
      text: '帮我做 修复 login，目录 /tmp/foo, 象限 1, Bug 修复 模板',
    })

    expect(r.action).toBe('wizard_done')
    expect(localAi.sessions[0].permissionMode).toBe('acceptEdits')
  })
```

Also add a reopen test near the existing `Telegram: ...` tests that cover `handleTopicStatusChange`:

```js
  it('Telegram: reopen uses configured telegram.defaultPermissionMode', async () => {
    const localAi = makeFakeAi()
    const localBridge = makeFakeBridge()
    const fakeTelegramBot = {
      editForumTopic: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    }
    const todo = db.createTodo({ title: 'reopen permission mode', quadrant: 2, workDir: '/tmp/foo' })
    db.updateTodo(todo.id, {
      status: 'done',
      aiSessions: [{
        sessionId: 'old-session',
        tool: 'claude',
        nativeSessionId: '12345678-1234-1234-1234-123456789abc',
        cwd: '/tmp/foo',
        telegramRoute: { targetUserId: '-100123', threadId: 77, topicName: '#t123 reopen permission mode', channel: 'telegram' },
      }],
    })
    const localWizard = createOpenClawWizard({
      db,
      aiTerminal: localAi,
      openclaw: localBridge,
      pending,
      telegramBot: fakeTelegramBot,
      getConfig: () => ({
        defaultCwd: '/tmp',
        port: 5677,
        defaultTool: 'claude',
        telegram: { defaultPermissionMode: 'default' },
      }),
    })

    const r = await localWizard.handleTopicStatusChange({
      chatId: '-100123',
      threadId: 77,
      status: 'reopened',
      topicName: '✅ #t123 reopen permission mode',
    })

    expect(r.action).toBe('reopened')
    expect(localAi.sessions).toHaveLength(1)
    expect(localAi.sessions[0].permissionMode).toBe('default')
  })
```

- [ ] **Step 2: Run wizard tests to verify failure**

Run:

```bash
npm test -- test/openclaw-wizard.test.js
```

Expected: FAIL because spawn still uses hard-coded `bypass`.

- [ ] **Step 3: Store effective permission mode in AI terminal sessions**

In `src/routes/ai-terminal.js`, add `permissionMode` to the session object:

```js
      const effectivePermissionMode = permissionMode || 'default'
      const session = {
        sessionId,
        todoId,
        tool,
        prompt,
        status: 'running',
        startedAt: Date.now(),
        completedAt: null,
        browsers: new Set(),
        outputHistory: [],
        outputSize: 0,
        nativeSessionId: resumeNativeId || null,
        recentOutput: '',
        cwd: sessionCwd,
        currentCwd: sessionCwd,
        permissionMode: effectivePermissionMode,
        autoMode: effectivePermissionMode !== 'default' ? effectivePermissionMode : null,
        lastOutputAt: null,
        outputBytesTotal: 0,
      }
```

Leave the later `pty.start({ permissionMode: permissionMode || null })` unchanged so CLI argument behavior stays the same.

- [ ] **Step 4: Use config in wizard create and reopen**

In `src/openclaw-wizard.js`, add this helper near other small helper functions:

```js
function telegramPermissionMode(cfg = {}) {
  const mode = cfg.telegram?.defaultPermissionMode
  return ['default', 'acceptEdits', 'bypass'].includes(mode) ? mode : 'bypass'
}
```

In `finalizeWizard`, after `const cfg = getConfig?.() || {}`, add:

```js
        const permissionMode = telegramPermissionMode(cfg)
```

Change the spawn call in `finalizeWizard` from:

```js
            permissionMode: 'bypass',
```

to:

```js
            permissionMode,
```

In the topic reopen path, after `const cfg = getConfig?.() || {}`, add:

```js
    const permissionMode = telegramPermissionMode(cfg)
```

Change the reopen spawn call from:

```js
        permissionMode: 'bypass',
```

to:

```js
        permissionMode,
```

- [ ] **Step 5: Run wizard tests to verify pass**

Run:

```bash
npm test -- test/openclaw-wizard.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/ai-terminal.js src/openclaw-wizard.js test/openclaw-wizard.test.js
git commit -m "feat(telegram): honor configured permission mode"
```

---

### Task 3: Add conservative Telegram permission callbacks

**Files:**
- Modify: `src/openclaw-wizard.js:1284-1315`
- Test: `test/openclaw-wizard.test.js`

- [ ] **Step 1: Write failing callback tests**

In `test/openclaw-wizard.test.js`, inside `describe('openclaw-wizard inline keyboard (callback_query)', ...)`, add:

```js
  it('permission allow callback sends Enter to the routed PTY session', async () => {
    const writes = []
    const localBridge = makeFakeBridge()
    localBridge.findSessionByShortId = (shortId) => shortId === 'abcd' ? 'ai-session-abcd' : null
    const localWizard = createOpenClawWizard({
      db,
      aiTerminal: { sessions: new Map([['ai-session-abcd', { todoId: 't1' }]]) },
      openclaw: localBridge,
      pending,
      pty: { has: (sid) => sid === 'ai-session-abcd', write: (sid, data) => writes.push({ sid, data }) },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const r = await localWizard.handleCallback({
      chatId: '-100123',
      threadId: 9,
      callbackData: 'qt:perm:abcd:allow',
    })

    expect(r.action).toBe('permission_allow_sent')
    expect(r.chosenLabel).toBe('允许（Enter）')
    expect(writes).toEqual([{ sid: 'ai-session-abcd', data: '\r' }])
  })

  it('permission deny callback sends Esc to the routed PTY session', async () => {
    const writes = []
    const localBridge = makeFakeBridge()
    localBridge.findSessionByShortId = (shortId) => shortId === 'abcd' ? 'ai-session-abcd' : null
    const localWizard = createOpenClawWizard({
      db,
      aiTerminal: { sessions: new Map([['ai-session-abcd', { todoId: 't1' }]]) },
      openclaw: localBridge,
      pending,
      pty: { has: (sid) => sid === 'ai-session-abcd', write: (sid, data) => writes.push({ sid, data }) },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const r = await localWizard.handleCallback({
      chatId: '-100123',
      threadId: 9,
      callbackData: 'qt:perm:abcd:deny',
    })

    expect(r.action).toBe('permission_deny_sent')
    expect(r.chosenLabel).toBe('拒绝/退出（Esc）')
    expect(writes).toEqual([{ sid: 'ai-session-abcd', data: '\x1b' }])
  })

  it('permission callback returns stale when session short id cannot be resolved', async () => {
    const localBridge = makeFakeBridge()
    localBridge.findSessionByShortId = () => null
    const localWizard = createOpenClawWizard({
      db,
      aiTerminal: { sessions: new Map() },
      openclaw: localBridge,
      pending,
      pty: { has: () => false, write: () => {} },
      getConfig: () => ({ defaultCwd: '/tmp', port: 5677, defaultTool: 'claude' }),
    })

    const r = await localWizard.handleCallback({
      chatId: '-100123',
      threadId: 9,
      callbackData: 'qt:perm:missing:allow',
    })

    expect(r.action).toBe('permission_session_stale')
    expect(r.reply).toContain('会话已结束')
  })
```

- [ ] **Step 2: Run callback tests to verify failure**

Run:

```bash
npm test -- test/openclaw-wizard.test.js
```

Expected: FAIL because `qt:perm:*` callbacks are not handled.

- [ ] **Step 3: Implement permission callback parsing and PTY writes**

In `src/openclaw-wizard.js`, near the existing callback constants, add:

```js
const PERMISSION_CALLBACK_KIND = 'perm'
const PERMISSION_ACTION_ALLOW = 'allow'
const PERMISSION_ACTION_DENY = 'deny'

function parsePermissionCallback(callbackData) {
  const parts = String(callbackData || '').split(':')
  if (parts.length !== 4) return null
  const [prefix, kind, shortId, action] = parts
  if (prefix !== CALLBACK_PREFIX || kind !== PERMISSION_CALLBACK_KIND) return null
  if (!shortId || ![PERMISSION_ACTION_ALLOW, PERMISSION_ACTION_DENY].includes(action)) return null
  return { shortId, action }
}
```

In `handleCallback`, after the ask_user callback block and before route callback handling, add:

```js
    const permissionCb = parsePermissionCallback(callbackData)
    if (permissionCb) {
      return handlePermissionCallback(permissionCb)
    }
```

Add this function near `handleAskUserCallback`:

```js
  function handlePermissionCallback(permissionCb) {
    const sid = openclaw?.findSessionByShortId?.(permissionCb.shortId) || null
    if (!sid || !pty?.has?.(sid)) {
      return {
        toast: '会话已结束',
        reply: '⚠️ 这个授权提醒对应的会话已结束，无需再点。',
        action: 'permission_session_stale',
        editOriginal: true,
      }
    }

    if (permissionCb.action === PERMISSION_ACTION_ALLOW) {
      pty.write(sid, '\r')
      return {
        toast: '已发送 Enter',
        chosenLabel: '允许（Enter）',
        action: 'permission_allow_sent',
        editOriginal: true,
      }
    }

    pty.write(sid, '\x1b')
    return {
      toast: '已发送 Esc',
      chosenLabel: '拒绝/退出（Esc）',
      action: 'permission_deny_sent',
      editOriginal: true,
    }
  }
```

- [ ] **Step 4: Run callback tests to verify pass**

Run:

```bash
npm test -- test/openclaw-wizard.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-wizard.js test/openclaw-wizard.test.js
git commit -m "feat(telegram): add permission action callbacks"
```

---

### Task 4: Send non-bypass authorization button reminders

**Files:**
- Modify: `src/openclaw-hook.js:240-260`, `src/openclaw-hook.js:307-336`, `src/openclaw-hook.js:444-458`
- Test: `test/openclaw-hook.test.js:166-326`

- [ ] **Step 1: Write failing hook tests**

Update `makeFakeBridge` in `test/openclaw-hook.test.js` to include route helpers:

```js
function makeFakeBridge({ sendOk = true, sendReason = null, route = null } = {}) {
  const sent = []
  return {
    sent,
    isEnabled: () => true,
    resolveRoute: vi.fn(() => route),
    postText: vi.fn(async ({ sessionId, message, replyMarkup }) => {
      sent.push({ sessionId, message, replyMarkup })
      if (sendOk) return { ok: true }
      return { ok: false, reason: sendReason || 'cli_failed' }
    }),
  }
}
```

Inside `describe('openclaw-hook handler', ...)`, add:

```js
  it('suppresses notification for bypass Telegram sessions by default', async () => {
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 7, targetUserId: '-100123' } })
    const aiTerminal = { sessions: new Map([['s1', { permissionMode: 'bypass', recentOutput: 'waiting' }]]) }
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal,
      getConfig: () => ({ telegram: { suppressNotificationEvents: true } }),
    })

    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })

    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_suppressed')
    expect(bridge.sent).toHaveLength(0)
  })

  it('does not suppress notification for non-bypass Telegram sessions', async () => {
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 7, targetUserId: '-100123' } })
    const aiTerminal = { sessions: new Map([['s1', { permissionMode: 'default', recentOutput: 'Do you want to allow this command?' }]]) }
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal,
      getConfig: () => ({ telegram: { suppressNotificationEvents: true, notificationCooldownMs: 0 } }),
    })

    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })

    expect(r.action).toBe('sent')
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0].message).toContain('等待授权')
    expect(bridge.sent[0].replyMarkup.inline_keyboard[0][0].text).toContain('允许')
    expect(bridge.sent[0].replyMarkup.inline_keyboard[0][0].callback_data).toBe('qt:perm:s1:allow')
    expect(bridge.sent[0].replyMarkup.inline_keyboard[0][1].callback_data).toBe('qt:perm:s1:deny')
  })

  it('respects explicit notification suppression for non-bypass Telegram sessions', async () => {
    bridge = makeFakeBridge({ route: { channel: 'telegram', threadId: 7, targetUserId: '-100123' } })
    const aiTerminal = { sessions: new Map([['s1', { permissionMode: 'default', recentOutput: 'Do you want to allow this command?' }]]) }
    handler = createOpenClawHookHandler({
      db,
      openclaw: bridge,
      aiTerminal,
      getConfig: () => ({ telegram: { suppressNotificationEvents: true, suppressPermissionNotifications: true } }),
    })

    const r = await handler.handle({ event: 'notification', sessionId: 's1', todoId: 't1' })

    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('notification_suppressed')
    expect(bridge.sent).toHaveLength(0)
  })
```

- [ ] **Step 2: Run hook tests to verify failure**

Run:

```bash
npm test -- test/openclaw-hook.test.js
```

Expected: FAIL because non-bypass notifications are still suppressed and no permission buttons are attached.

- [ ] **Step 3: Implement helper functions in `src/openclaw-hook.js`**

Inside `createOpenClawHookHandler`, after `notificationSuppressed()`, add:

```js
  function getSessionPermissionMode(sessionId) {
    try {
      const sess = sessionId && aiTerminal?.sessions?.get?.(sessionId)
      return sess?.permissionMode || sess?.autoMode || 'default'
    } catch { return 'default' }
  }

  function isTelegramSession(sessionId) {
    try {
      const route = openclaw?.resolveRoute?.(sessionId)
      return route?.channel === 'telegram' || !!route?.threadId
    } catch { return false }
  }

  function suppressPermissionNotifications() {
    try {
      return getConfig?.()?.telegram?.suppressPermissionNotifications === true
    } catch { return false }
  }

  function shouldBypassNotificationSuppression(sessionId) {
    if (!sessionId) return false
    if (!isTelegramSession(sessionId)) return false
    if (suppressPermissionNotifications()) return false
    return getSessionPermissionMode(sessionId) !== 'bypass'
  }

  function buildPermissionReplyMarkup(sessionId) {
    const shortId = String(sessionId || '').slice(-4)
    return {
      inline_keyboard: [[
        { text: '允许（Enter）', callback_data: `qt:perm:${shortId}:allow` },
        { text: '拒绝/退出（Esc）', callback_data: `qt:perm:${shortId}:deny` },
      ]],
    }
  }

  function isPermissionishNotification(text) {
    return /permission|approval|approve|allow|authorize|confirm|确认|授权|允许|批准/i.test(String(text || ''))
  }
```

- [ ] **Step 4: Change notification suppression logic**

Replace:

```js
    if (evt === 'notification' && notificationSuppressed()) {
      return { ok: true, action: 'skipped', reason: 'notification_suppressed' }
    }
```

with:

```js
    const bypassNotificationSuppression = evt === 'notification' && shouldBypassNotificationSuppression(sessionId)
    if (evt === 'notification' && notificationSuppressed() && !bypassNotificationSuppression) {
      return { ok: true, action: 'skipped', reason: 'notification_suppressed' }
    }
```

- [ ] **Step 5: Attach conservative button reminder to non-bypass notifications**

Before `const result = await openclaw.postText({ ... })`, add:

```js
    let replyMarkup = null
    if (evt === 'notification' && shouldBypassNotificationSuppression(sessionId)) {
      const permissionish = isPermissionishNotification(`${cleanContent || ''}\n${snippet || ''}\n${historicalRaw || ''}`)
      const prefix = permissionish
        ? '⚠️ Claude Code 正在等待授权确认。'
        : '⚠️ Claude Code 可能正在等待输入或授权。'
      message = [
        prefix,
        '可以点「允许（Enter）」按当前默认项继续，或点「拒绝/退出（Esc）」退出当前确认。',
        '',
        message,
      ].join('\n')
      replyMarkup = buildPermissionReplyMarkup(sessionId)
    }
```

Then add `replyMarkup` to the `postText` call:

```js
    const result = await openclaw.postText({
      sessionId,
      message,
      attachment: attachmentPath,
      replyMarkup,
    })
```

- [ ] **Step 6: Run hook tests to verify pass**

Run:

```bash
npm test -- test/openclaw-hook.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.test.js
git commit -m "feat(telegram): send permission reminder buttons"
```

---

### Task 5: Add settings UI support

**Files:**
- Modify: `web/src/api.ts:117-138`
- Modify: `web/src/SettingsDrawer.tsx:134-150`, `web/src/SettingsDrawer.tsx:190-207`, `web/src/SettingsDrawer.tsx:626-640`

- [ ] **Step 1: Add TypeScript config field**

In `web/src/api.ts`, add this field inside `AppConfig.telegram`:

```ts
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'bypass'
```

- [ ] **Step 2: Wire form load and save**

In `web/src/SettingsDrawer.tsx`, add this field to `form.setFieldsValue` in the config load effect:

```ts
          telegramDefaultPermissionMode: result.config.telegram?.defaultPermissionMode || 'bypass',
```

Add this field to the `telegram` patch in `handleSave`:

```ts
          defaultPermissionMode: values.telegramDefaultPermissionMode || 'bypass',
```

- [ ] **Step 3: Add the Telegram settings control**

In `web/src/SettingsDrawer.tsx`, inside the `Telegram · 通知行为` collapse section after `telegramSuppressNotificationEvents`, add:

```tsx
                  <Form.Item
                    name="telegramDefaultPermissionMode"
                    label="Telegram 默认权限模式"
                    extra="新建/恢复 Telegram 任务时使用。非 bypass 模式下，等待授权时会发 Telegram 按钮提醒。"
                  >
                    <Radio.Group>
                      <Radio.Button value="default">默认（需确认）</Radio.Button>
                      <Radio.Button value="acceptEdits">半托管</Radio.Button>
                      <Radio.Button value="bypass">完全托管</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
```

- [ ] **Step 4: Build the web UI**

Run:

```bash
npm run build:web
```

Expected: PASS and `dist-web` assets regenerate.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/SettingsDrawer.tsx dist-web
git commit -m "feat(settings): expose telegram permission mode"
```

---

### Task 6: Final verification

**Files:**
- Verify changed files only.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
npm test -- test/config.test.js test/openclaw-wizard.test.js test/openclaw-hook.test.js
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Build web assets**

Run:

```bash
npm run build:web
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat HEAD~5..HEAD
```

Expected: only config, Telegram wizard/hook, settings UI, tests, and generated web assets are changed.

- [ ] **Step 5: Manual smoke test**

Start the app:

```bash
npm start
```

In the web settings drawer:

1. Open Telegram settings.
2. Confirm `Telegram 默认权限模式` shows `完全托管` by default.
3. Change it to `默认（需确认）` and save.
4. Create a Telegram task.
5. Confirm server logs show the spawned Claude session with `permissionMode: "default"` behavior, not `bypassPermissions`.
6. When Claude Code waits for a permission/confirmation, confirm the Telegram topic receives a message with `允许（Enter）` and `拒绝/退出（Esc）` buttons.
7. Click `拒绝/退出（Esc）` and confirm the original Telegram message is edited to remove buttons and show `✓ 已选: 拒绝/退出（Esc）`.

- [ ] **Step 6: Commit verification fixes if any**

If verification revealed a small fix, commit only that fix:

```bash
git add <fixed-files>
git commit -m "fix(telegram): stabilize permission reminder flow"
```

---

## Self-Review

**Spec coverage:**
- Configurable Telegram permission mode: Task 1 and Task 2.
- Default remains bypass: Task 1 tests and Task 2 existing/default wizard test.
- Telegram create and reopen use the config: Task 2.
- Non-bypass authorization notification compatibility: Task 4.
- Conservative Telegram buttons for allow/deny: Task 3 and Task 4.
- Settings UI support: Task 5.
- Verification: Task 6.

**Placeholder scan:** No placeholder tasks or undefined implementation steps remain. Every code-editing step includes concrete snippets and every test step includes exact commands.

**Type consistency:** `defaultPermissionMode` is used consistently in server config, web API type, settings form, and wizard spawn logic. Permission callbacks use the `qt:perm:<shortId>:allow|deny` format consistently between hook reply markup and wizard callback parsing.
