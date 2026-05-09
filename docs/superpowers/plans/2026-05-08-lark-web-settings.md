# Lark Web Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Web settings UI for the existing Lark/Feishu notification config while grouping Telegram and Lark under one notification-channel section.

**Architecture:** Keep the backend unchanged and make a focused frontend-only change. Extend the Web `AppConfig` type with `lark`, load/save Lark form values in `SettingsDrawer`, and wrap the existing Telegram panel plus the new Lark panel under a shared **通知渠道** section.

**Tech Stack:** React 18, TypeScript, Ant Design 5, Vite, Vitest source-regression tests.

---

## File Structure

- Create `test/settings-drawer-lark-config.test.js` — source-regression coverage for the new Lark config type, load/save fields, and notification-channel layout.
- Modify `web/src/api.ts` — add `AppConfig.lark` so frontend config consumers can read and update Lark settings safely.
- Modify `web/src/SettingsDrawer.tsx` — load Lark config into form values, include Lark config in the save payload, and render the **通知渠道** section containing Telegram and Lark panels.

---

### Task 1: Add failing Web settings regression tests

**Files:**
- Create: `test/settings-drawer-lark-config.test.js`

- [ ] **Step 1: Create the failing source-regression test**

Create `test/settings-drawer-lark-config.test.js` with this exact content:

```js
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const settingsSource = fs.readFileSync(path.resolve('web/src/SettingsDrawer.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.resolve('web/src/api.ts'), 'utf8')

describe('SettingsDrawer Lark notification settings', () => {
  it('types the Lark config returned by /api/config', () => {
    expect(apiSource).toContain('lark?: {')
    expect(apiSource).toContain('requireThreadGroup?: boolean')
    expect(apiSource).toContain('eventSubscribeEnabled?: boolean')
    expect(apiSource).toContain('notificationCooldownMs?: number')
  })

  it('loads and saves Lark form values through the existing config endpoint', () => {
    expect(settingsSource).toContain('larkEnabled: result.config.lark?.enabled ?? false')
    expect(settingsSource).toContain("larkChatId: result.config.lark?.chatId || ''")
    expect(settingsSource).toContain('larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false')
    expect(settingsSource).toContain('larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false')
    expect(settingsSource).toContain('larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000')
    expect(settingsSource).toContain('lark: {')
    expect(settingsSource).toContain('enabled: Boolean(values.larkEnabled)')
    expect(settingsSource).toContain("chatId: String(values.larkChatId || '').trim()")
    expect(settingsSource).toContain('requireThreadGroup: values.larkRequireThreadGroup !== false')
    expect(settingsSource).toContain('eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false')
    expect(settingsSource).toContain('notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0')
  })

  it('groups Telegram and Lark under the notification-channel section', () => {
    expect(settingsSource).toContain('<Text strong>通知渠道</Text>')
    expect(settingsSource).toContain("key: 'telegram'")
    expect(settingsSource).toContain("key: 'lark'")
    expect(settingsSource).toContain('Telegram · 话题群同步、bot 配置、通知与白名单')
    expect(settingsSource).toContain('Lark / 飞书 · 话题群双向通知')
    expect(settingsSource).toContain('Lark 的话题由话题群中的主消息/thread 承载，不是 Telegram Forum Topic 那种原生 topic 对象。')
    expect(settingsSource).toContain('name="larkEnabled"')
    expect(settingsSource).toContain('name="larkChatId"')
    expect(settingsSource).toContain('name="larkRequireThreadGroup"')
    expect(settingsSource).toContain('name="larkEventSubscribeEnabled"')
    expect(settingsSource).toContain('name="larkNotificationCooldownMs"')
  })
})
```

- [ ] **Step 2: Run the regression test and verify it fails**

Run:

```bash
npx vitest run test/settings-drawer-lark-config.test.js --pool=forks
```

Expected: FAIL because `web/src/api.ts` does not define `AppConfig.lark` and `SettingsDrawer` does not contain Lark form fields or the **通知渠道** section yet.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/settings-drawer-lark-config.test.js
git commit -m "test: cover lark web settings config"
```

---

### Task 2: Add the frontend Lark config type and load/save fields

**Files:**
- Modify: `web/src/api.ts:124-147`
- Modify: `web/src/SettingsDrawer.tsx:128-169`, `web/src/SettingsDrawer.tsx:181-241`
- Test: `test/settings-drawer-lark-config.test.js`

- [ ] **Step 1: Add `AppConfig.lark` to the Web API type**

In `web/src/api.ts`, after the closing brace of the `telegram?: { ... }` block and before `pricing: PricingConfig`, add:

```ts
  lark?: {
    enabled?: boolean
    chatId?: string
    requireThreadGroup?: boolean
    eventSubscribeEnabled?: boolean
    notificationCooldownMs?: number
    [key: string]: unknown
  }
```

The surrounding section should become:

```ts
  telegram?: {
    enabled?: boolean
    supergroupId?: string
    longPollTimeoutSec?: number
    useTopics?: boolean
    createTopicOnTaskStart?: boolean
    closeTopicOnSessionEnd?: boolean
    topicNameTemplate?: string
    topicNameDoneTemplate?: string
    allowedChatIds?: string[]
    allowedFromUserIds?: string[]
    notificationCooldownMs?: number
    suppressNotificationEvents?: boolean
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'bypass'
    autoCreateTopic?: boolean
    pollRetryDelayMs?: number
    minRenameIntervalMs?: number
    botToken?: string
    botTokenMasked?: string | null
    botTokenSource?: 'quadtodo' | 'openclaw' | 'missing'
    defaultSupergroupId?: string
    [key: string]: unknown
  }
  lark?: {
    enabled?: boolean
    chatId?: string
    requireThreadGroup?: boolean
    eventSubscribeEnabled?: boolean
    notificationCooldownMs?: number
    [key: string]: unknown
  }
  pricing: PricingConfig
```

- [ ] **Step 2: Load Lark values into the settings form**

In `web/src/SettingsDrawer.tsx`, inside the `form.setFieldsValue({ ... })` call that already sets Telegram fields, add these fields immediately after `telegramMinRenameIntervalMs`:

```ts
          larkEnabled: result.config.lark?.enabled ?? false,
          larkChatId: result.config.lark?.chatId || '',
          larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false,
          larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false,
          larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000,
```

The end of that block should become:

```ts
          telegramDefaultPermissionMode: result.config.telegram?.defaultPermissionMode || 'bypass',
          telegramLongPollTimeoutSec: result.config.telegram?.longPollTimeoutSec ?? 30,
          telegramPollRetryDelayMs: result.config.telegram?.pollRetryDelayMs ?? 5000,
          telegramMinRenameIntervalMs: result.config.telegram?.minRenameIntervalMs ?? 30000,
          larkEnabled: result.config.lark?.enabled ?? false,
          larkChatId: result.config.lark?.chatId || '',
          larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false,
          larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false,
          larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000,
          pricingCnyRate: result.config.pricing.cnyRate,
```

- [ ] **Step 3: Save Lark values through `updateConfig()`**

In `web/src/SettingsDrawer.tsx`, inside the object passed to `updateConfig({ ... })`, add a `lark` block immediately after the existing `telegram` block:

```ts
        lark: {
          enabled: Boolean(values.larkEnabled),
          chatId: String(values.larkChatId || '').trim(),
          requireThreadGroup: values.larkRequireThreadGroup !== false,
          eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false,
          notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0,
        },
```

The transition from `telegram` to `pricing` should become:

```ts
        telegram: {
          enabled: Boolean(values.telegramEnabled),
          botToken: values.telegramBotToken || '',
          supergroupId: values.telegramSupergroupId || '',
          allowedChatIds: String(values.telegramAllowedChatIds || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
          allowedFromUserIds: String(values.telegramAllowedFromUserIds || '').split('\n').map((s: string) => s.trim()).filter(Boolean),
          useTopics: values.telegramUseTopics !== false,
          createTopicOnTaskStart: values.telegramCreateTopicOnTaskStart !== false,
          closeTopicOnSessionEnd: values.telegramCloseTopicOnSessionEnd !== false,
          topicNameTemplate: values.telegramTopicNameTemplate || '#t{shortCode} {title}',
          topicNameDoneTemplate: values.telegramTopicNameDoneTemplate || '✅ {originalName}',
          autoCreateTopic: values.telegramAutoCreateTopic !== false,
          notificationCooldownMs: Number(values.telegramNotificationCooldownMs) || 0,
          suppressNotificationEvents: values.telegramSuppressNotificationEvents !== false,
          defaultPermissionMode: values.telegramDefaultPermissionMode || 'bypass',
          longPollTimeoutSec: Number(values.telegramLongPollTimeoutSec) || 30,
          pollRetryDelayMs: Number(values.telegramPollRetryDelayMs) || 5000,
          minRenameIntervalMs: Number(values.telegramMinRenameIntervalMs) || 30000,
        },
        lark: {
          enabled: Boolean(values.larkEnabled),
          chatId: String(values.larkChatId || '').trim(),
          requireThreadGroup: values.larkRequireThreadGroup !== false,
          eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false,
          notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0,
        },
        pricing: {
```

- [ ] **Step 4: Run the regression test and verify partial progress**

Run:

```bash
npx vitest run test/settings-drawer-lark-config.test.js --pool=forks
```

Expected: still FAIL, but only the layout/UI assertions should remain missing. The type and load/save assertions should pass.

- [ ] **Step 5: Commit the type and data-flow change**

```bash
git add web/src/api.ts web/src/SettingsDrawer.tsx
git commit -m "feat: wire lark settings data flow"
```

---

### Task 3: Render the notification-channel section with Telegram and Lark panels

**Files:**
- Modify: `web/src/SettingsDrawer.tsx:538-701`
- Test: `test/settings-drawer-lark-config.test.js`

- [ ] **Step 1: Replace the standalone Telegram heading with a notification-channel heading**

In `web/src/SettingsDrawer.tsx`, replace:

```tsx
        <Paragraph style={{ marginTop: 24, marginBottom: 12 }}>
          <Text strong>Telegram</Text>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            话题群同步、bot 配置、通知与白名单。改完保存后会自动重启长轮询。
          </Text>
        </Paragraph>
```

with:

```tsx
        <Paragraph style={{ marginTop: 24, marginBottom: 12 }}>
          <Text strong>通知渠道</Text>
          <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
            Telegram 和 Lark / 飞书的双向通知配置。
          </Text>
        </Paragraph>
```

- [ ] **Step 2: Wrap the existing Telegram collapse in an outer `Collapse` panel**

Replace the current Telegram `<Collapse defaultActiveKey={['basic', 'topic', 'notify', 'security']} items={[ ... ]} />` with an outer collapse whose first item has `key: 'telegram'` and contains the existing Telegram collapse as its children.

The outer structure should be:

```tsx
        <Collapse
          defaultActiveKey={['telegram', 'lark']}
          items={[
            {
              key: 'telegram',
              label: 'Telegram · 话题群同步、bot 配置、通知与白名单',
              children: (
                <Collapse
                  defaultActiveKey={['basic', 'topic', 'notify', 'security']}
                  items={[
                    {
                      key: 'basic',
                      label: 'Telegram · 基础',
                      children: (
                        <>
                          <Form.Item name="telegramEnabled" label="启用 Telegram" valuePropName="checked">
                            <Switch />
                          </Form.Item>

                          <Form.Item label="Bot Token" required>
                            <Space.Compact style={{ width: '100%' }}>
                              <Form.Item name="telegramBotToken" noStyle>
                                <Input.Password placeholder="paste token here，留空 = 用兜底来源" autoComplete="new-password" />
                              </Form.Item>
                              <Button
                                loading={testing}
                                onClick={async () => {
                                  setTesting(true)
                                  try {
                                    const rawToken = String(form.getFieldValue('telegramBotToken') || '').trim()
                                    const input = rawToken && !isMaskedToken(rawToken) ? { botToken: rawToken } : {}
                                    const r = await testTelegram(input)
                                    if (r.ok) {
                                      const sourceLabel = telegramSourceLabel(r.source)
                                      setTestResult(`✓ ${r.botUsername ? '@' + r.botUsername : `id=${r.botId}`}（来源：${sourceLabel}）`)
                                      message.success(r.source === 'input' ? 'Telegram 连通，保存后生效' : 'Telegram 连通')
                                    } else {
                                      setTestResult(`✗ ${r.errorReason || 'unknown'}`)
                                      message.error(r.errorReason || '测试失败')
                                    }
                                  } catch (e: any) {
                                    setTestResult(`✗ ${e.message}`)
                                  } finally {
                                    setTesting(false)
                                  }
                                }}
                              >测试</Button>
                            </Space.Compact>
                            <div style={{ marginTop: 4, fontSize: 12 }}>
                              <Tag color={tokenSource === 'quadtodo' ? 'default' : tokenSource === 'openclaw' ? 'orange' : 'error'}>
                                {tokenSource === 'quadtodo' && '来自 quadtodo 配置'}
                                {tokenSource === 'openclaw' && '来自 ~/.openclaw/openclaw.json（兜底）'}
                                {tokenSource === 'missing' && '未配置'}
                              </Tag>
                              {testResult && <span style={{ marginLeft: 8 }}>{testResult}</span>}
                            </div>
                          </Form.Item>

                          <Form.Item label="Supergroup ID">
                            <Space.Compact style={{ width: '100%' }}>
                              <Form.Item name="telegramSupergroupId" noStyle>
                                <Input placeholder="-1001234567890" />
                              </Form.Item>
                              <Button onClick={() => setProbeOpen(true)}>抓 ID</Button>
                            </Space.Compact>
                          </Form.Item>

                          <Form.Item
                            name="telegramAllowedChatIds"
                            label="白名单 chatIds"
                            extra="一行一个 chat_id；空 = 拒绝所有（强制白名单）"
                          >
                            <Input.TextArea rows={3} placeholder="-1001234567890" />
                          </Form.Item>
                        </>
                      ),
                    },
                    {
                      key: 'topic',
                      label: 'Telegram · Topic 行为',
                      children: (
                        <>
                          <Form.Item name="telegramUseTopics" label="启用 Topics" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                          <Form.Item name="telegramCreateTopicOnTaskStart" label="任务启动时建 Topic" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                          <Form.Item name="telegramCloseTopicOnSessionEnd" label="Session 结束关 Topic" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                          <Form.Item name="telegramAutoCreateTopic" label="非 wizard 起的 PTY 自动镜像" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                          <Form.Item name="telegramTopicNameTemplate" label="Topic 名模板" extra="占位符：{shortCode} {title}">
                            <Input />
                          </Form.Item>
                          <Form.Item name="telegramTopicNameDoneTemplate" label="完成模板" extra="占位符：{originalName}">
                            <Input />
                          </Form.Item>
                        </>
                      ),
                    },
                    {
                      key: 'notify',
                      label: 'Telegram · 通知行为',
                      children: (
                        <>
                          <Form.Item
                            name="telegramNotificationCooldownMs"
                            label="同 session idle 提醒最小间隔 (ms)"
                            extra="0 = 关闭去重，每次都推。默认 600000（10 分钟）。"
                          >
                            <InputNumber min={0} step={60_000} style={{ width: '100%' }} />
                          </Form.Item>
                          <Form.Item name="telegramSuppressNotificationEvents" label="丢弃 idle Notification 事件" valuePropName="checked">
                            <Switch />
                          </Form.Item>
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
                        </>
                      ),
                    },
                    {
                      key: 'security',
                      label: 'Telegram · 安全',
                      children: (
                        <Form.Item
                          name="telegramAllowedFromUserIds"
                          label="白名单 fromUserIds"
                          extra="一行一个 user_id；空 = 不限"
                        >
                          <Input.TextArea rows={3} />
                        </Form.Item>
                      ),
                    },
                    {
                      key: 'advanced',
                      label: 'Telegram · 高级（不动也行）',
                      children: (
                        <>
                          <Form.Item name="telegramLongPollTimeoutSec" label="长轮询超时 (秒)">
                            <InputNumber min={5} max={120} style={{ width: '100%' }} />
                          </Form.Item>
                          <Form.Item name="telegramPollRetryDelayMs" label="拉取失败退避起点 (ms)">
                            <InputNumber min={500} step={500} style={{ width: '100%' }} />
                          </Form.Item>
                          <Form.Item name="telegramMinRenameIntervalMs" label="Topic 重命名最小间隔 (ms)">
                            <InputNumber min={1000} step={1000} style={{ width: '100%' }} />
                          </Form.Item>
                        </>
                      ),
                    },
                  ]}
                />
              ),
            },
```

- [ ] **Step 3: Add the Lark panel as the second outer collapse item**

Immediately after the Telegram outer item from Step 2, before the closing `]}` of the outer `Collapse`, add:

```tsx
            {
              key: 'lark',
              label: 'Lark / 飞书 · 话题群双向通知',
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Lark 话题群适配说明"
                    description="Lark 的话题由话题群中的主消息/thread 承载，不是 Telegram Forum Topic 那种原生 topic 对象。"
                  />

                  <Form.Item name="larkEnabled" label="启用 Lark / 飞书通知" valuePropName="checked">
                    <Switch />
                  </Form.Item>

                  <Form.Item
                    name="larkChatId"
                    label="话题群 Chat ID"
                    extra="目标群需要是话题群/thread group；机器人需要在群内并具备发消息权限。"
                  >
                    <Input placeholder="oc_xxxxxxxxxxxxxxxxx" />
                  </Form.Item>

                  <Form.Item
                    name="larkRequireThreadGroup"
                    label="要求目标群为话题群 / thread group"
                    valuePropName="checked"
                    extra="保持开启可避免误把普通群当作话题群使用。"
                  >
                    <Switch />
                  </Form.Item>

                  <Form.Item
                    name="larkEventSubscribeEnabled"
                    label="启用事件订阅，用于双向消息"
                    valuePropName="checked"
                    extra="关闭后只能从 quadtodo 推送到 Lark，Lark 里的回复不会回到本地会话。"
                  >
                    <Switch />
                  </Form.Item>

                  <Form.Item
                    name="larkNotificationCooldownMs"
                    label="同 session idle 提醒最小间隔 (ms)"
                    extra="0 = 关闭去重，每次都推。默认 600000（10 分钟）。"
                  >
                    <InputNumber min={0} step={60_000} style={{ width: '100%' }} />
                  </Form.Item>
                </>
              ),
            },
```

- [ ] **Step 4: Run the regression test and verify it passes**

Run:

```bash
npx vitest run test/settings-drawer-lark-config.test.js --pool=forks
```

Expected: PASS. The test should confirm `AppConfig.lark`, Lark load/save fields, and the **通知渠道** UI strings are present.

- [ ] **Step 5: Commit the UI rendering change**

```bash
git add web/src/SettingsDrawer.tsx test/settings-drawer-lark-config.test.js
git commit -m "feat: add lark notification settings UI"
```

---

### Task 4: Verify build and focused regressions

**Files:**
- Verify: `web/src/api.ts`
- Verify: `web/src/SettingsDrawer.tsx`
- Verify: `test/settings-drawer-lark-config.test.js`

- [ ] **Step 1: Run the focused Web settings regression test**

Run:

```bash
npx vitest run test/settings-drawer-lark-config.test.js --pool=forks
```

Expected: PASS.

- [ ] **Step 2: Run Telegram config regression tests**

Run:

```bash
npx vitest run test/telegram-config.route.test.js test/api.telegram.test.js --pool=forks --exclude "**/.worktrees/**" --exclude "**/.claude/**"
```

Expected: PASS. This checks that the Web UI work did not require changing Telegram config APIs.

- [ ] **Step 3: Run the Web production build**

Run:

```bash
npm run build:web
```

Expected: PASS with TypeScript and Vite build completing successfully.

- [ ] **Step 4: Review the browser UI manually**

Run:

```bash
cd web && npm run dev
```

Open the Vite URL printed by the command. In the settings drawer, verify:

- The section heading says **通知渠道**.
- The outer panels include **Telegram · 话题群同步、bot 配置、通知与白名单** and **Lark / 飞书 · 话题群双向通知**.
- The Telegram panel still contains Bot Token, Supergroup ID, Topic behavior, notification behavior, security, and advanced settings.
- The Lark panel contains all five fields: enable switch, Chat ID, require thread group switch, event subscription switch, and cooldown input.

Stop the dev server after checking.

- [ ] **Step 5: Commit any final verification-only fixes**

If the verification steps required code changes, commit them:

```bash
git add web/src/api.ts web/src/SettingsDrawer.tsx test/settings-drawer-lark-config.test.js
git commit -m "fix: verify lark web settings"
```

If no code changed during verification, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: Task 2 covers `AppConfig.lark` plus load/save data flow; Task 3 covers the **通知渠道** layout, preserved Telegram UI, and new Lark fields; Task 4 covers build and regression verification.
- Placeholder scan: The plan contains concrete paths, code snippets, commands, and expected outcomes. It does not rely on deferred implementation details.
- Type consistency: Field names are consistent across API type, form loading, save payload, UI controls, and tests: `larkEnabled`, `larkChatId`, `larkRequireThreadGroup`, `larkEventSubscribeEnabled`, `larkNotificationCooldownMs`.
