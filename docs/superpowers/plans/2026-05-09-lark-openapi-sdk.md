# Lark OpenAPI SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the user-facing `lark-cli` dependency by sending Lark messages with `@larksuiteoapi/node-sdk` `Client` and receiving `im.message.receive_v1` events with `WSClient` long-connection mode.

**Architecture:** Keep `createLarkBot()` as the runtime facade consumed by `server.js`, `openclaw-bridge.js`, and `openclaw-wizard.js`. Move SDK-specific outbound calls into `src/lark-api-client.js`, SDK WebSocket event subscription into `src/lark-event-client.js`, and keep routing/dedupe/wizard retry semantics inside `src/lark-bot.js`. Treat Lark `appSecret` like Telegram `botToken`: write-only from Web, masked on read, preserved when the Web client sends back the masked value.

**Tech Stack:** Node.js ESM, Express, `@larksuiteoapi/node-sdk`, React + TypeScript, Ant Design, Vitest with `--pool=forks`.

---

## File Structure

- Modify: `package.json` / `package-lock.json`
  - Add runtime dependency `@larksuiteoapi/node-sdk`.
- Modify: `src/config.js`
  - Add `appId` and `appSecret` to Lark defaults and trim string credentials during normalization.
- Create: `src/lark-config-service.js`
  - Own Lark secret masking helpers: `maskLarkAppSecret()`, `isMaskedLarkAppSecret()`, `larkAppSecretSource()`.
- Modify: `src/server.js`
  - Mask `config.lark.appSecret` in `/api/config` GET/PUT responses.
  - Preserve existing secret when PUT receives the masked value or an empty value.
  - Add `POST /api/config/lark/test` to validate credentials without sending chat messages.
  - Restart Lark stack when `appId`, `appSecret`, `chatId`, `enabled`, or event settings change.
- Create: `src/lark-api-client.js`
  - Wrap SDK `Client` root message, thread reply, and credential test calls.
- Create: `src/lark-event-client.js`
  - Wrap SDK `WSClient` + `EventDispatcher` for `im.message.receive_v1`.
- Modify: `src/lark-bot.js`
  - Remove `node:child_process` spawn usage.
  - Compose `createLarkApiClient()` and `createLarkEventClient()`.
  - Preserve `sendMessage`, `replyInThread`, `handleEvent`, `start`, `stop`, `describe`, and `__test__.normalizeEvent` shape.
- Modify: `web/src/api.ts`
  - Add Lark credential fields and `testLark()` API helper.
- Modify: `web/src/SettingsDrawer.tsx`
  - Add App ID/App Secret fields, masked secret loading/saving, credential status tag, and test button in the existing Lark panel.
- Modify: `test/config.test.js`
  - Cover new Lark defaults and normalization.
- Modify: `test/server.test.js`
  - Cover Lark secret masking, secret preservation, and restart on credential changes.
- Create: `test/lark-api-client.test.js`
  - Mock SDK `Client` and assert outbound OpenAPI payloads.
- Create: `test/lark-event-client.test.js`
  - Mock SDK `WSClient` and `EventDispatcher`, assert event registration and dispatch.
- Modify: `test/lark-bot.test.js`
  - Replace CLI spawn assertions with injected SDK-client factory assertions while preserving inbound routing/retry coverage.
- Modify: `test/settings-drawer-lark-config.test.js`
  - Extend source-regression checks for App ID/App Secret/status/test UI.

---

### Task 1: Add SDK dependency and Lark credential config

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.js:95-101`
- Create: `src/lark-config-service.js`
- Modify: `test/config.test.js:248-290`

- [ ] **Step 1: Add failing config tests**

Update the Lark tests in `test/config.test.js` to expect SDK credential defaults and trimmed credentials:

```js
describe('lark defaults', () => {
	it('adds lark defaults when config file omits lark section', async () => {
		const { loadConfig } = await import('../src/config.js');
		const tmp = mkdtempSync(join(tmpdir(), 'quadtodo-lark-config-'));
		try {
			const cfg = loadConfig({ rootDir: tmp });
			expect(cfg.lark).toEqual({
				enabled: false,
				appId: '',
				appSecret: '',
				chatId: '',
				requireThreadGroup: true,
				eventSubscribeEnabled: true,
				notificationCooldownMs: 600000,
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('normalizes lark credentials, chatId, and preserves explicit booleans', async () => {
		const { loadConfig } = await import('../src/config.js');
		const tmp = mkdtempSync(join(tmpdir(), 'quadtodo-lark-config-'));
		try {
			writeFileSync(join(tmp, 'config.json'), JSON.stringify({
				lark: {
					enabled: true,
					appId: '  cli_a123  ',
					appSecret: '  secret_abc  ',
					chatId: '  oc_abc  ',
					requireThreadGroup: false,
					eventSubscribeEnabled: false,
					notificationCooldownMs: 0,
				},
			}));
			const cfg = loadConfig({ rootDir: tmp });
			expect(cfg.lark).toEqual({
				enabled: true,
				appId: 'cli_a123',
				appSecret: 'secret_abc',
				chatId: 'oc_abc',
				requireThreadGroup: false,
				eventSubscribeEnabled: false,
				notificationCooldownMs: 0,
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run the config tests and verify they fail**

Run:

```bash
npx vitest run test/config.test.js --pool=forks
```

Expected: FAIL because `cfg.lark` does not include `appId` or `appSecret` yet.

- [ ] **Step 3: Install the official SDK dependency**

Run:

```bash
npm install @larksuiteoapi/node-sdk@^1.63.1
```

Expected: `package.json` and `package-lock.json` include `@larksuiteoapi/node-sdk` under runtime dependencies.

- [ ] **Step 4: Extend Lark config defaults and normalization**

Change `DEFAULT_LARK_CONFIG` in `src/config.js` to:

```js
const DEFAULT_LARK_CONFIG = {
	enabled: false,
	appId: "",
	appSecret: "",
	chatId: "",
	requireThreadGroup: true,
	eventSubscribeEnabled: true,
	notificationCooldownMs: 600_000,
};
```

Change the `lark` section in `normalizeConfig()` from the current `chatId`-only normalization to:

```js
		lark: {
			...DEFAULT_LARK_CONFIG,
			...(cfg.lark || {}),
			appId: typeof cfg.lark?.appId === "string"
				? cfg.lark.appId.trim()
				: DEFAULT_LARK_CONFIG.appId,
			appSecret: typeof cfg.lark?.appSecret === "string"
				? cfg.lark.appSecret.trim()
				: DEFAULT_LARK_CONFIG.appSecret,
			chatId: typeof cfg.lark?.chatId === "string"
				? cfg.lark.chatId.trim()
				: DEFAULT_LARK_CONFIG.chatId,
		},
```

- [ ] **Step 5: Add Lark secret masking helpers**

Create `src/lark-config-service.js`:

```js
const MASK_PREFIX = 'lark_***'

export function maskLarkAppSecret(secret) {
  if (!secret || typeof secret !== 'string') return null
  const tail = secret.length >= 4 ? secret.slice(-4) : secret
  return MASK_PREFIX + tail
}

export function isMaskedLarkAppSecret(value) {
  return typeof value === 'string' && value.startsWith(MASK_PREFIX)
}

export function larkAppSecretSource(config) {
  const secret = config?.lark?.appSecret
  return secret && typeof secret === 'string' ? 'quadtodo' : 'missing'
}
```

- [ ] **Step 6: Run the config tests and verify they pass**

Run:

```bash
npx vitest run test/config.test.js --pool=forks
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/config.js src/lark-config-service.js test/config.test.js
git commit -m "feat: add lark sdk credential config"
```

---

### Task 2: Add outbound Lark OpenAPI client wrapper

**Files:**
- Create: `src/lark-api-client.js`
- Create: `test/lark-api-client.test.js`

- [ ] **Step 1: Write failing outbound SDK wrapper tests**

Create `test/lark-api-client.test.js`:

```js
import { describe, expect, it, vi } from 'vitest'
import { createLarkApiClient } from '../src/lark-api-client.js'

function makeSdkClient(overrides = {}) {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({ data: { message_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://example.test/msg' } }),
        reply: vi.fn().mockResolvedValue({ data: { message_id: 'om_reply' } }),
      },
    },
    auth: {
      tenantAccessToken: {
        internal: vi.fn().mockResolvedValue({ tenant_access_token: 't-1', expire: 7200 }),
      },
    },
    ...overrides,
  }
}

describe('lark-api-client', () => {
  it('sends root text messages with chat_id receive id type', async () => {
    const sdkClient = makeSdkClient()
    const clientFactory = vi.fn(() => sdkClient)
    const client = createLarkApiClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      clientFactory,
    })

    const result = await client.sendMessage({ chatId: 'oc_123', text: 'hello lark' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_root', thread_id: 'omt_1', message_app_link: 'https://example.test/msg' } })
    expect(clientFactory).toHaveBeenCalledWith({ appId: 'cli_a123', appSecret: 'secret' })
    expect(sdkClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'hello lark' }),
      },
    })
  })

  it('replies inside a Lark thread', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      clientFactory: () => sdkClient,
    })

    const result = await client.replyInThread({ rootMessageId: 'om_root', text: 'thread reply' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_reply' } })
    expect(sdkClient.im.message.reply).toHaveBeenCalledWith({
      path: { message_id: 'om_root' },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: 'thread reply' }),
        reply_in_thread: true,
      },
    })
  })

  it('fails closed when credentials or required fields are missing', async () => {
    const noCreds = createLarkApiClient({ appId: '', appSecret: '', clientFactory: () => makeSdkClient() })
    await expect(noCreds.sendMessage({ chatId: 'oc_123', text: 'hello' })).resolves.toEqual({ ok: false, reason: 'lark_credentials_missing' })

    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => makeSdkClient() })
    await expect(client.sendMessage({ text: 'hello' })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(client.sendMessage({ chatId: 'oc_123' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    await expect(client.replyInThread({ text: 'hello' })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(client.replyInThread({ rootMessageId: 'om_root' })).resolves.toEqual({ ok: false, reason: 'text_required' })
  })

  it('normalizes SDK failures into structured reasons', async () => {
    const sdkClient = makeSdkClient({
      im: {
        message: {
          create: vi.fn().mockRejectedValue(new Error('send exploded')),
          reply: vi.fn().mockRejectedValue(new Error('reply exploded')),
        },
      },
    })
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    await expect(client.sendMessage({ chatId: 'oc_123', text: 'hello' })).resolves.toEqual({ ok: false, reason: 'lark_send_failed', detail: 'send exploded' })
    await expect(client.replyInThread({ rootMessageId: 'om_root', text: 'hello' })).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'reply exploded' })
  })

  it('tests credentials without sending a chat message', async () => {
    const sdkClient = makeSdkClient()
    const client = createLarkApiClient({ appId: 'cli_a123', appSecret: 'secret', clientFactory: () => sdkClient })

    const result = await client.testConnection()

    expect(result).toEqual({ ok: true })
    expect(sdkClient.auth.tenantAccessToken.internal).toHaveBeenCalledWith({
      data: { app_id: 'cli_a123', app_secret: 'secret' },
    })
    expect(sdkClient.im.message.create).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
npx vitest run test/lark-api-client.test.js --pool=forks
```

Expected: FAIL with module-not-found for `src/lark-api-client.js`.

- [ ] **Step 3: Implement the SDK wrapper**

Create `src/lark-api-client.js`:

```js
import * as Lark from '@larksuiteoapi/node-sdk'

function isBlank(value) {
  return value == null || String(value) === ''
}

function normalizePayload(response) {
  return response?.data || response || null
}

function normalizeError(error) {
  return error?.message || error?.description || String(error)
}

function defaultClientFactory({ appId, appSecret }) {
  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
  })
}

export function createLarkApiClient({ appId, appSecret, clientFactory = defaultClientFactory, logger = console } = {}) {
  let client = null

  function hasCredentials() {
    return !isBlank(appId) && !isBlank(appSecret)
  }

  function getClient() {
    if (!hasCredentials()) return null
    if (!client) client = clientFactory({ appId, appSecret })
    return client
  }

  async function sendMessage({ chatId, text } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    try {
      const response = await getClient().im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: String(chatId),
          msg_type: 'text',
          content: JSON.stringify({ text: String(text) }),
        },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] send failed: ${detail}`)
      return { ok: false, reason: 'lark_send_failed', detail }
    }
  }

  async function replyInThread({ rootMessageId, text } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    try {
      const response = await getClient().im.message.reply({
        path: { message_id: String(rootMessageId) },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: String(text) }),
          reply_in_thread: true,
        },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] reply failed: ${detail}`)
      return { ok: false, reason: 'lark_reply_failed', detail }
    }
  }

  async function testConnection() {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    try {
      const sdkClient = getClient()
      if (sdkClient.auth?.tenantAccessToken?.internal) {
        await sdkClient.auth.tenantAccessToken.internal({
          data: { app_id: String(appId), app_secret: String(appSecret) },
        })
      } else {
        await sendMessage({ chatId: '', text: '' })
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: 'lark_client_init_failed', detail: normalizeError(e) }
    }
  }

  return { sendMessage, replyInThread, testConnection }
}
```

- [ ] **Step 4: Run outbound SDK wrapper tests and verify they pass**

Run:

```bash
npx vitest run test/lark-api-client.test.js --pool=forks
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lark-api-client.js test/lark-api-client.test.js
git commit -m "feat: add lark openapi message client"
```

---

### Task 3: Add inbound Lark long-connection event client

**Files:**
- Create: `src/lark-event-client.js`
- Create: `test/lark-event-client.test.js`

- [ ] **Step 1: Write failing event-client tests**

Create `test/lark-event-client.test.js`:

```js
import { describe, expect, it, vi } from 'vitest'
import { createLarkEventClient } from '../src/lark-event-client.js'

function makeDispatcherFactory(calls) {
  return vi.fn(() => ({
    register: vi.fn((handlers) => {
      calls.handlers = handlers
      return { registered: true, handlers }
    }),
  }))
}

function makeWsClientFactory(calls) {
  return vi.fn((config) => {
    calls.config = config
    return {
      start: vi.fn((options) => {
        calls.startOptions = options
      }),
      stop: vi.fn(() => {
        calls.stopped = true
      }),
    }
  })
}

describe('lark-event-client', () => {
  it('registers im.message.receive_v1 and starts WSClient', async () => {
    const calls = {}
    const onEvent = vi.fn().mockResolvedValue({ ok: true })
    const client = createLarkEventClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      onEvent,
      dispatcherFactory: makeDispatcherFactory(calls),
      wsClientFactory: makeWsClientFactory(calls),
      logger: { warn() {}, info() {} },
    })

    const result = await client.start()

    expect(result).toEqual({ ok: true, action: 'started' })
    expect(calls.config).toMatchObject({ appId: 'cli_a123', appSecret: 'secret' })
    expect(calls.handlers).toHaveProperty('im.message.receive_v1')
    expect(calls.startOptions.eventDispatcher).toEqual({ registered: true, handlers: calls.handlers })
    expect(client.describe()).toMatchObject({ running: true, reason: null })

    await calls.handlers['im.message.receive_v1']({ event_id: 'evt_1', event: { message: { message_id: 'om_1' } } })
    expect(onEvent).toHaveBeenCalledWith({ event_id: 'evt_1', event: { message: { message_id: 'om_1' } } })
  })

  it('stops the WS client and reports stopped status', async () => {
    const calls = {}
    const client = createLarkEventClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      onEvent: vi.fn(),
      dispatcherFactory: makeDispatcherFactory(calls),
      wsClientFactory: makeWsClientFactory(calls),
      logger: { warn() {}, info() {} },
    })

    await client.start()
    await expect(client.stop()).resolves.toEqual({ ok: true })

    expect(calls.stopped).toBe(true)
    expect(client.describe()).toMatchObject({ running: false })
  })

  it('fails closed when credentials are missing or WS start throws', async () => {
    const missing = createLarkEventClient({ appId: '', appSecret: '', onEvent: vi.fn() })
    await expect(missing.start()).resolves.toEqual({ ok: false, reason: 'lark_credentials_missing' })

    const throwing = createLarkEventClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      onEvent: vi.fn(),
      dispatcherFactory: vi.fn(() => ({ register: vi.fn(() => ({})) })),
      wsClientFactory: vi.fn(() => ({ start: vi.fn(() => { throw new Error('ws exploded') }) })),
      logger: { warn() {}, info() {} },
    })

    await expect(throwing.start()).resolves.toEqual({ ok: false, reason: 'lark_ws_start_failed', detail: 'ws exploded' })
    expect(throwing.describe()).toMatchObject({ running: false, reason: 'lark_ws_start_failed' })
  })

  it('surfaces event handler failures as structured logs without throwing to the SDK', async () => {
    const calls = {}
    const warnings = []
    const client = createLarkEventClient({
      appId: 'cli_a123',
      appSecret: 'secret',
      onEvent: vi.fn().mockRejectedValue(new Error('handler exploded')),
      dispatcherFactory: makeDispatcherFactory(calls),
      wsClientFactory: makeWsClientFactory(calls),
      logger: { warn: (message) => warnings.push(message), info() {} },
    })

    await client.start()
    await expect(calls.handlers['im.message.receive_v1']({ event_id: 'evt_1' })).resolves.toBeUndefined()
    expect(warnings.join('\n')).toContain('lark_event_handler_failed')
  })
})
```

- [ ] **Step 2: Run event-client tests and verify they fail**

Run:

```bash
npx vitest run test/lark-event-client.test.js --pool=forks
```

Expected: FAIL with module-not-found for `src/lark-event-client.js`.

- [ ] **Step 3: Implement the long-connection wrapper**

Create `src/lark-event-client.js`:

```js
import * as Lark from '@larksuiteoapi/node-sdk'

function isBlank(value) {
  return value == null || String(value) === ''
}

function normalizeError(error) {
  return error?.message || error?.description || String(error)
}

function defaultDispatcherFactory() {
  return new Lark.EventDispatcher({})
}

function defaultWsClientFactory({ appId, appSecret }) {
  return new Lark.WSClient({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    loggerLevel: Lark.LoggerLevel?.info,
  })
}

export function createLarkEventClient({
  appId,
  appSecret,
  onEvent,
  dispatcherFactory = defaultDispatcherFactory,
  wsClientFactory = defaultWsClientFactory,
  logger = console,
} = {}) {
  if (typeof onEvent !== 'function') throw new Error('onEvent_required')

  let wsClient = null
  let running = false
  let lastReason = null
  let lastDetail = null

  function hasCredentials() {
    return !isBlank(appId) && !isBlank(appSecret)
  }

  async function start() {
    if (!hasCredentials()) {
      lastReason = 'lark_credentials_missing'
      lastDetail = null
      return { ok: false, reason: 'lark_credentials_missing' }
    }
    if (running) return { ok: true, action: 'already_running' }

    try {
      const eventDispatcher = dispatcherFactory().register({
        'im.message.receive_v1': async (data) => {
          try {
            await onEvent(data)
          } catch (e) {
            const detail = normalizeError(e)
            logger.warn?.(`[lark-event] lark_event_handler_failed: ${detail}`)
          }
        },
      })
      wsClient = wsClientFactory({ appId, appSecret })
      wsClient.start({ eventDispatcher })
      running = true
      lastReason = null
      lastDetail = null
      return { ok: true, action: 'started' }
    } catch (e) {
      running = false
      wsClient = null
      lastReason = 'lark_ws_start_failed'
      lastDetail = normalizeError(e)
      logger.warn?.(`[lark-event] websocket start failed: ${lastDetail}`)
      return { ok: false, reason: lastReason, detail: lastDetail }
    }
  }

  async function stop() {
    running = false
    const current = wsClient
    wsClient = null
    if (current?.stop) await current.stop()
    return { ok: true }
  }

  function describe() {
    return {
      running,
      reason: lastReason,
      detail: lastDetail,
    }
  }

  return { start, stop, describe }
}
```

- [ ] **Step 4: Run event-client tests and verify they pass**

Run:

```bash
npx vitest run test/lark-event-client.test.js --pool=forks
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lark-event-client.js test/lark-event-client.test.js
git commit -m "feat: add lark websocket event client"
```

---

### Task 4: Refactor `createLarkBot()` away from `lark-cli`

**Files:**
- Modify: `src/lark-bot.js`
- Modify: `test/lark-bot.test.js`

- [ ] **Step 1: Replace outbound CLI tests with SDK facade tests**

In `test/lark-bot.test.js`, remove the `EventEmitter` process helper and spawn-based assertions. Add this helper near the top:

```js
function makeApiClient(overrides = {}) {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_sent' } }),
    replyInThread: vi.fn().mockResolvedValue({ ok: true, payload: { message_id: 'om_reply' } }),
    ...overrides,
  }
}

function makeEventClient(overrides = {}) {
  return {
    start: vi.fn().mockResolvedValue({ ok: true, action: 'started' }),
    stop: vi.fn().mockResolvedValue({ ok: true }),
    describe: vi.fn(() => ({ running: true, reason: null })),
    ...overrides,
  }
}

function makeBot(overrides = {}) {
  const wizard = overrides.wizard || { handleInbound: vi.fn() }
  const getConfig = overrides.getConfig || (() => ({
    lark: {
      enabled: true,
      appId: 'cli_a123',
      appSecret: 'secret',
      chatId: 'oc_default',
      eventSubscribeEnabled: true,
    },
  }))
  const logger = overrides.logger || { warn() {}, info() {} }
  const apiClient = overrides.apiClient || makeApiClient()
  const eventClient = overrides.eventClient || makeEventClient()
  const apiClientFactory = overrides.apiClientFactory || vi.fn(() => apiClient)
  const eventClientFactory = overrides.eventClientFactory || vi.fn(() => eventClient)
  const bot = createLarkBot({
    getConfig,
    wizard,
    logger,
    apiClientFactory,
    eventClientFactory,
  })
  return { bot, wizard, logger, apiClient, eventClient, apiClientFactory, eventClientFactory }
}
```

Replace the outbound `describe` block with:

```js
describe('lark-bot outbound SDK facade', () => {
  it('sendMessage delegates to the Lark API client', async () => {
    const { bot, apiClient, apiClientFactory } = makeBot()

    const result = await bot.sendMessage({ chatId: 'oc_123', text: 'hello lark' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_sent' } })
    expect(apiClientFactory).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'cli_a123',
      appSecret: 'secret',
    }))
    expect(apiClient.sendMessage).toHaveBeenCalledWith({ chatId: 'oc_123', text: 'hello lark' })
  })

  it('replyInThread delegates to the Lark API client', async () => {
    const { bot, apiClient } = makeBot()

    const result = await bot.replyInThread({ rootMessageId: 'om_root', text: 'thread reply' })

    expect(result).toEqual({ ok: true, payload: { message_id: 'om_reply' } })
    expect(apiClient.replyInThread).toHaveBeenCalledWith({ rootMessageId: 'om_root', text: 'thread reply' })
  })

  it('returns validation errors without creating an API call', async () => {
    const { bot, apiClient } = makeBot()

    await expect(bot.sendMessage({ text: 'hi' })).resolves.toEqual({ ok: false, reason: 'chatId_required' })
    await expect(bot.sendMessage({ chatId: 'oc_123' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    await expect(bot.replyInThread({ text: 'hi' })).resolves.toEqual({ ok: false, reason: 'rootMessageId_required' })
    await expect(bot.replyInThread({ rootMessageId: 'om_root' })).resolves.toEqual({ ok: false, reason: 'text_required' })
    expect(apiClient.sendMessage).not.toHaveBeenCalled()
    expect(apiClient.replyInThread).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Update inbound retry assertions to inspect API client calls**

Keep the current inbound event cases, but replace `spawnFn` setup with `apiClient` setup. For the main-stream retry test, use:

```js
const apiClient = makeApiClient({
  sendMessage: vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: 'lark_send_failed', detail: 'send failed' })
    .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_sent' } }),
})
const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'please deliver', action: 'answered' }) }
const { bot } = makeBot({ apiClient, wizard })
const event = { event_id: 'evt_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_reply_retry', content: '{"text":"reply retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_send_failed', detail: 'send failed' })
await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered' })
await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
expect(apiClient.sendMessage).toHaveBeenCalledTimes(2)
expect(apiClient.sendMessage).toHaveBeenLastCalledWith({ chatId: 'oc_default', text: 'please deliver' })
```

For the thread retry test, use:

```js
const apiClient = makeApiClient({
  replyInThread: vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: 'lark_reply_failed', detail: 'reply failed' })
    .mockResolvedValueOnce({ ok: true, payload: { message_id: 'om_reply' } }),
})
const wizard = { handleInbound: vi.fn().mockResolvedValue({ reply: 'thread answer', action: 'answered_thread' }) }
const { bot } = makeBot({ apiClient, wizard })
const event = { event_id: 'evt_thread_reply_retry', event: { message: { chat_id: 'oc_default', message_id: 'om_thread_retry', root_id: 'om_root_retry', content: '{"text":"thread retry"}' }, sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' } } }

await expect(bot.handleEvent(event)).resolves.toEqual({ ok: false, reason: 'lark_reply_failed', detail: 'reply failed' })
await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'answered_thread' })
await expect(bot.handleEvent(event)).resolves.toEqual({ ok: true, action: 'duplicate' })

expect(wizard.handleInbound).toHaveBeenCalledTimes(1)
expect(apiClient.replyInThread).toHaveBeenCalledTimes(2)
expect(apiClient.replyInThread).toHaveBeenLastCalledWith({ rootMessageId: 'om_root_retry', text: 'thread answer' })
```

- [ ] **Step 3: Update lifecycle tests for event client start/stop**

Replace the subscription lifecycle tests with:

```js
describe('lark-bot subscription lifecycle', () => {
  it('start starts the SDK event client when enabled and credentialed', async () => {
    const eventClient = makeEventClient()
    const { bot, eventClientFactory } = makeBot({ eventClient })

    await expect(bot.start()).resolves.toEqual({ ok: true, action: 'started' })

    expect(eventClientFactory).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'cli_a123',
      appSecret: 'secret',
      onEvent: expect.any(Function),
    }))
    expect(eventClient.start).toHaveBeenCalledTimes(1)
    expect(bot.describe()).toMatchObject({
      enabled: true,
      chatId: 'oc_default',
      eventSubscribeEnabled: true,
      running: true,
    })
  })

  it('start fails closed when credentials are missing', async () => {
    const { bot, eventClient } = makeBot({
      getConfig: () => ({ lark: { enabled: true, appId: '', appSecret: '', chatId: 'oc_default', eventSubscribeEnabled: true } }),
    })

    await expect(bot.start()).resolves.toEqual({ ok: false, reason: 'lark_credentials_missing' })
    expect(eventClient.start).not.toHaveBeenCalled()
  })

  it('stop stops the SDK event client and reports not running', async () => {
    const eventClient = makeEventClient()
    const { bot } = makeBot({ eventClient })

    await bot.start()
    await expect(bot.stop()).resolves.toEqual({ ok: true })

    expect(eventClient.stop).toHaveBeenCalledTimes(1)
    expect(bot.describe().running).toBe(false)
  })
})
```

- [ ] **Step 4: Run Lark bot tests and verify they fail**

Run:

```bash
npx vitest run test/lark-bot.test.js --pool=forks
```

Expected: FAIL because `createLarkBot()` still accepts `spawnFn` and spawns `lark-cli`.

- [ ] **Step 5: Refactor `src/lark-bot.js` to compose SDK clients**

At the top of `src/lark-bot.js`, remove:

```js
import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 60_000
```

Add:

```js
import { createLarkApiClient } from './lark-api-client.js'
import { createLarkEventClient } from './lark-event-client.js'
```

Delete `runCli()`, `scheduleRestart()`, `attachSubscriber()`, `proc`, `buffer`, and `restartTimer`.

Change `createLarkBot()` signature to:

```js
export function createLarkBot({
  getConfig,
  wizard,
  apiClientFactory = createLarkApiClient,
  eventClientFactory = createLarkEventClient,
  logger = console,
} = {}) {
```

Inside the factory, keep `seenEvents`, `pendingReplyRetries`, and `running`, and add:

```js
  let apiClient = null
  let eventClient = null

  function credentialsFromConfig() {
    const lark = getConfig()?.lark || {}
    return {
      appId: lark.appId || '',
      appSecret: lark.appSecret || '',
    }
  }

  function hasCredentials() {
    const { appId, appSecret } = credentialsFromConfig()
    return !isBlank(appId) && !isBlank(appSecret)
  }

  function getApiClient() {
    if (!apiClient) {
      apiClient = apiClientFactory({
        ...credentialsFromConfig(),
        logger,
      })
    }
    return apiClient
  }
```

Replace `sendMessage()` and `replyInThread()` with:

```js
  async function sendMessage({ chatId, text } = {}) {
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().sendMessage({ chatId, text })
  }

  async function replyInThread({ rootMessageId, text } = {}) {
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (isBlank(text)) return { ok: false, reason: 'text_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().replyInThread({ rootMessageId, text })
  }
```

Replace `start()`, `stop()`, and `describe()` with:

```js
  async function start() {
    const cfg = getConfig()?.lark || {}
    if (!cfg.enabled || cfg.eventSubscribeEnabled === false) return { ok: false, reason: 'disabled' }
    if (isBlank(cfg.chatId)) return { ok: false, reason: 'chatId_missing' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (running) return { ok: true, action: 'already_running' }

    eventClient = eventClientFactory({
      ...credentialsFromConfig(),
      onEvent: handleEvent,
      logger,
    })
    const result = await eventClient.start()
    if (!result?.ok) return result
    running = true
    return { ok: true, action: 'started' }
  }

  async function stop() {
    running = false
    const current = eventClient
    eventClient = null
    if (current?.stop) await current.stop()
    return { ok: true }
  }

  function describe() {
    const cfg = getConfig()?.lark || {}
    const eventStatus = eventClient?.describe?.() || null
    return {
      enabled: !!cfg.enabled,
      chatId: cfg.chatId || '',
      eventSubscribeEnabled: cfg.eventSubscribeEnabled !== false,
      running,
      eventStatus,
    }
  }
```

Keep the existing `normalizeEvent()`, `extractText()`, `rememberSeen()`, `handleEvent()`, retry cache logic, and return shape.

- [ ] **Step 6: Run Lark bot tests and verify they pass**

Run:

```bash
npx vitest run test/lark-bot.test.js --pool=forks
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lark-bot.js test/lark-bot.test.js
git commit -m "refactor: use lark sdk clients in bot runtime"
```

---

### Task 5: Mask Lark secrets and add backend test endpoint

**Files:**
- Modify: `src/server.js:41-45`, `src/server.js:474-603`, `src/server.js:1065-1084`
- Modify: `test/server.test.js:158-238`

- [ ] **Step 1: Add failing server tests for secret masking and restart**

In `test/server.test.js`, update `GET /api/config returns current config including lark defaults` to include masked secret metadata:

```js
expect(r.body.config.lark).toMatchObject({
	enabled: false,
	appId: '',
	chatId: '',
	requireThreadGroup: true,
	eventSubscribeEnabled: true,
	appSecretMasked: null,
	appSecretSource: 'missing',
});
expect(r.body.config.lark).not.toHaveProperty('appSecret');
```

Add this test near the existing Lark config PUT test:

```js
it("PUT /api/config masks lark appSecret and preserves it when masked or empty", async () => {
	const first = await request(srv.app)
		.put("/api/config")
		.send({
			lark: {
				enabled: true,
				appId: "cli_a123",
				appSecret: "secret_abc1234",
				chatId: "oc_test_chat",
			},
		});

	expect(first.status).toBe(200);
	expect(first.body.config.lark).toMatchObject({
		enabled: true,
		appId: "cli_a123",
		chatId: "oc_test_chat",
		appSecretMasked: "lark_***1234",
		appSecretSource: "quadtodo",
	});
	expect(first.body.config.lark).not.toHaveProperty("appSecret");
	expect(loadConfig({ rootDir: configRootDir }).lark.appSecret).toBe("secret_abc1234");

	const masked = await request(srv.app)
		.put("/api/config")
		.send({
			lark: {
				appId: "cli_b456",
				appSecret: "lark_***1234",
			},
		});

	expect(masked.status).toBe(200);
	expect(loadConfig({ rootDir: configRootDir }).lark.appId).toBe("cli_b456");
	expect(loadConfig({ rootDir: configRootDir }).lark.appSecret).toBe("secret_abc1234");

	const empty = await request(srv.app)
		.put("/api/config")
		.send({ lark: { appSecret: "" } });

	expect(empty.status).toBe(200);
	expect(loadConfig({ rootDir: configRootDir }).lark.appSecret).toBe("secret_abc1234");
});
```

Add this test for credential restart:

```js
it("PUT /api/config restarts lark when credentials change", async () => {
	const update = await request(srv.app)
		.put("/api/config")
		.send({
			lark: {
				enabled: false,
				appId: "cli_restart",
				appSecret: "secret_restart",
				chatId: "oc_restart",
			},
		});

	expect(update.status).toBe(200);
	expect(update.body.runtimeApplied.larkRestart).toEqual({ applied: true });
	expect(loadConfig({ rootDir: configRootDir }).lark.appId).toBe("cli_restart");
	expect(loadConfig({ rootDir: configRootDir }).lark.appSecret).toBe("secret_restart");
});
```

- [ ] **Step 2: Run server tests and verify they fail**

Run:

```bash
npx vitest run test/server.test.js --pool=forks
```

Expected: FAIL because `/api/config` still returns raw `lark.appSecret` once present and does not preserve masked/empty Lark secrets.

- [ ] **Step 3: Add masking imports and response helper in `src/server.js`**

Change imports near `telegram-config-service.js`:

```js
import { createProbeRegistry, isMaskedToken, maskBotToken } from "./telegram-config-service.js";
import { isMaskedLarkAppSecret, larkAppSecretSource, maskLarkAppSecret } from "./lark-config-service.js";
import { createLarkApiClient } from "./lark-api-client.js";
```

Add helper near the top-level utility functions:

```js
function buildSafeLarkConfig(cfg) {
	const { appSecret: _appSecret, ...larkSafe } = cfg.lark || {};
	return {
		...larkSafe,
		appSecretMasked: maskLarkAppSecret(cfg.lark?.appSecret),
		appSecretSource: larkAppSecretSource(cfg),
	};
}
```

- [ ] **Step 4: Mask Lark config in GET and PUT responses**

In `GET /api/config`, add Lark masking:

```js
			const { token, source } = readBotTokenWithSource(() => cfg);
			const { botToken: _botToken, ...telegramSafe } = cfg.telegram || {};
			res.json({
				ok: true,
				config: {
					...cfg,
					tools: resolveToolsConfig(cfg.tools),
					telegram: {
						...telegramSafe,
						botTokenMasked: maskBotToken(token),
						botTokenSource: source,
					},
					lark: buildSafeLarkConfig(cfg),
				},
				toolDiagnostics: inspectToolsConfig(cfg.tools),
			});
```

In `PUT /api/config`, replace the current Lark patch merge with:

```js
			const larkPatch = { ...(req.body?.lark || {}) };
			if ('appSecret' in larkPatch) {
				const secret = larkPatch.appSecret;
				if (isMaskedLarkAppSecret(secret) || secret === '') {
					delete larkPatch.appSecret;
				}
			}
			delete larkPatch.appSecretMasked;
			delete larkPatch.appSecretSource;
			const mergedLark = { ...current.lark, ...larkPatch };
```

In the PUT response config object, add:

```js
					lark: buildSafeLarkConfig(reloadedCfg),
```

- [ ] **Step 5: Add `/api/config/lark/test` without sending chat messages**

Add this route after `/api/config` PUT and before `/api/config/workdirs`:

```js
	app.post("/api/config/lark/test", async (req, res) => {
		try {
			const current = loadConfig({ rootDir: configRootDir });
			const inputAppId = typeof req.body?.appId === "string" ? req.body.appId.trim() : "";
			const inputSecret = typeof req.body?.appSecret === "string" ? req.body.appSecret.trim() : "";
			const appId = inputAppId || current.lark?.appId || "";
			const appSecret = inputSecret && !isMaskedLarkAppSecret(inputSecret)
				? inputSecret
				: current.lark?.appSecret || "";
			const source = inputAppId || inputSecret ? "input" : larkAppSecretSource(current);
			const client = createLarkApiClient({ appId, appSecret });
			const result = await client.testConnection();
			if (result.ok) {
				res.json({ ok: true, source });
				return;
			}
			res.json({ ok: false, source, errorReason: result.reason, detail: result.detail });
		} catch (e) {
			res.json({ ok: false, source: "input", errorReason: e.message || "unknown" });
		}
	});
```

- [ ] **Step 6: Make Lark stack startup credential-aware**

In `startLarkStack()` after the `enabled` check, add:

```js
		if (!lark.appId || !lark.appSecret) {
			larkBotHolder.current = null
			try { openclawBridge.setLarkBot?.(null) } catch { /* ignore */ }
			console.warn('[lark] enabled but appId/appSecret missing; skipping bot start')
			return
		}
```

Keep `createLarkBot()` construction unchanged except that it now creates SDK clients internally.

- [ ] **Step 7: Run server tests and verify they pass**

Run:

```bash
npx vitest run test/server.test.js --pool=forks
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: add lark credential config api"
```

---

### Task 6: Add Web App ID/App Secret settings and connection test

**Files:**
- Modify: `web/src/api.ts:147-154`, `web/src/api.ts:944-963`
- Modify: `web/src/SettingsDrawer.tsx:1-4`, `web/src/SettingsDrawer.tsx:88-93`, `web/src/SettingsDrawer.tsx:121-178`, `web/src/SettingsDrawer.tsx:182-281`, Lark collapse section
- Modify: `test/settings-drawer-lark-config.test.js`

- [ ] **Step 1: Extend source-regression tests for Web Lark credentials**

Update `test/settings-drawer-lark-config.test.js`:

```js
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const settingsSource = fs.readFileSync(path.resolve('web/src/SettingsDrawer.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.resolve('web/src/api.ts'), 'utf8')

describe('SettingsDrawer Lark notification settings', () => {
  it('types the Lark config returned by /api/config', () => {
    expect(apiSource).toContain('lark?: {')
    expect(apiSource).toContain('appId?: string')
    expect(apiSource).toContain('appSecret?: string')
    expect(apiSource).toContain('appSecretMasked?: string | null')
    expect(apiSource).toContain("appSecretSource?: 'quadtodo' | 'missing'")
    expect(apiSource).toContain('requireThreadGroup?: boolean')
    expect(apiSource).toContain('eventSubscribeEnabled?: boolean')
    expect(apiSource).toContain('notificationCooldownMs?: number')
    expect(apiSource).toContain('export async function testLark')
  })

  it('loads and saves Lark form values through the existing config endpoint', () => {
    expect(settingsSource).toContain('larkAppId: result.config.lark?.appId || \'\'')
    expect(settingsSource).toContain('larkAppSecret: result.config.lark?.appSecretMasked || \'\'')
    expect(settingsSource).toContain('larkEnabled: result.config.lark?.enabled ?? false')
    expect(settingsSource).toContain("larkChatId: result.config.lark?.chatId || ''")
    expect(settingsSource).toContain('larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false')
    expect(settingsSource).toContain('larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false')
    expect(settingsSource).toContain('larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000')
    expect(settingsSource).toContain('appId: String(values.larkAppId || \'\').trim()')
    expect(settingsSource).toContain('appSecret: values.larkAppSecret || \'\'')
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
    expect(settingsSource).toContain('name="larkAppId"')
    expect(settingsSource).toContain('name="larkAppSecret"')
    expect(settingsSource).toContain('name="larkEnabled"')
    expect(settingsSource).toContain('name="larkChatId"')
    expect(settingsSource).toContain('name="larkRequireThreadGroup"')
    expect(settingsSource).toContain('name="larkEventSubscribeEnabled"')
    expect(settingsSource).toContain('name="larkNotificationCooldownMs"')
    expect(settingsSource).toContain('来自 quadtodo 配置')
    expect(settingsSource).toContain('未配置')
    expect(settingsSource).toContain('Lark 连通')
  })
})
```

- [ ] **Step 2: Run Web source tests and verify they fail**

Run:

```bash
npx vitest run test/settings-drawer-lark-config.test.js --pool=forks
```

Expected: FAIL because App ID/App Secret/test UI is not yet present.

- [ ] **Step 3: Extend `AppConfig.lark` and add `testLark()`**

In `web/src/api.ts`, change the `lark` interface to:

```ts
  lark?: {
    enabled?: boolean
    appId?: string
    appSecret?: string
    appSecretMasked?: string | null
    appSecretSource?: 'quadtodo' | 'missing'
    chatId?: string
    requireThreadGroup?: boolean
    eventSubscribeEnabled?: boolean
    notificationCooldownMs?: number
    [key: string]: unknown
  }
```

Near the Telegram config helpers, add:

```ts
export interface LarkTestResult {
  ok: boolean
  source: 'quadtodo' | 'missing' | 'input'
  errorReason?: string
  detail?: string
}

export async function testLark(input: { appId?: string; appSecret?: string } = {}): Promise<LarkTestResult> {
  const r = await fetch(BASE + '/api/config/lark/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return await r.json() as LarkTestResult
}
```

- [ ] **Step 4: Add Lark secret state and helpers in `SettingsDrawer.tsx`**

Change the import from `./api` to include `testLark`:

```ts
import { getStatus, getConfig, updateConfig, AppConfig, pickDirectory, ToolDiagnostic, testTelegram, testLark, type ProbeHit } from './api'
```

Add helpers near `isMaskedToken()`:

```ts
function isMaskedLarkSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('lark_***')
}

function larkSourceLabel(source: 'quadtodo' | 'missing' | 'input'): string {
  if (source === 'input') return '当前输入，保存后生效'
  if (source === 'quadtodo') return 'quadtodo'
  return 'missing'
}
```

Add state next to Telegram token/test state:

```ts
  const [larkSecretSource, setLarkSecretSource] = useState<'quadtodo' | 'missing'>('missing')
  const [larkTesting, setLarkTesting] = useState(false)
  const [larkTestResult, setLarkTestResult] = useState<string | null>(null)
```

- [ ] **Step 5: Load and save Lark credentials in the form**

In the `form.setFieldsValue()` load block, add:

```ts
          larkAppId: result.config.lark?.appId || '',
          larkAppSecret: result.config.lark?.appSecretMasked || '',
```

After setting Telegram token state, add:

```ts
        setLarkSecretSource((result.config.lark?.appSecretSource as 'quadtodo' | 'missing' | undefined) || 'missing')
```

In the Lark save payload, add:

```ts
          appId: String(values.larkAppId || '').trim(),
          appSecret: values.larkAppSecret || '',
```

After save result state updates, add:

```ts
      setLarkSecretSource((result.config.lark?.appSecretSource as 'quadtodo' | 'missing' | undefined) || 'missing')
```

- [ ] **Step 6: Render App ID/App Secret/status/test controls in the Lark panel**

In the existing Lark collapse children, insert these form items before `larkChatId`:

```tsx
<Form.Item name="larkAppId" label="App ID" extra="飞书/Lark 自建应用的 App ID，例如 cli_xxx。">
  <Input placeholder="cli_xxx" />
</Form.Item>

<Form.Item label="App Secret" required>
  <Space.Compact style={{ width: '100%' }}>
    <Form.Item name="larkAppSecret" noStyle>
      <Input.Password placeholder="paste app secret here，留空/遮罩 = 保留现有值" autoComplete="new-password" />
    </Form.Item>
    <Button
      loading={larkTesting}
      onClick={async () => {
        setLarkTesting(true)
        try {
          const rawAppId = String(form.getFieldValue('larkAppId') || '').trim()
          const rawSecret = String(form.getFieldValue('larkAppSecret') || '').trim()
          const input = {
            appId: rawAppId,
            appSecret: rawSecret && !isMaskedLarkSecret(rawSecret) ? rawSecret : undefined,
          }
          const r = await testLark(input)
          if (r.ok) {
            setLarkTestResult(`✓ 来源：${larkSourceLabel(r.source)}`)
            message.success(r.source === 'input' ? 'Lark 连通，保存后生效' : 'Lark 连通')
          } else {
            setLarkTestResult(`✗ ${r.errorReason || 'unknown'}`)
            message.error(r.errorReason || '测试失败')
          }
        } catch (e: any) {
          setLarkTestResult(`✗ ${e.message}`)
        } finally {
          setLarkTesting(false)
        }
      }}
    >测试</Button>
  </Space.Compact>
  <div style={{ marginTop: 4, fontSize: 12 }}>
    <Tag color={larkSecretSource === 'quadtodo' ? 'default' : 'error'}>
      {larkSecretSource === 'quadtodo' && '来自 quadtodo 配置'}
      {larkSecretSource === 'missing' && '未配置'}
    </Tag>
    {larkTestResult && <span style={{ marginLeft: 8 }}>{larkTestResult}</span>}
  </div>
</Form.Item>
```

- [ ] **Step 7: Run Web source test and Web build**

Run:

```bash
npx vitest run test/settings-drawer-lark-config.test.js --pool=forks
npm run build:web
```

Expected: Vitest PASS and Web build PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/api.ts web/src/SettingsDrawer.tsx test/settings-drawer-lark-config.test.js
git commit -m "feat: add lark sdk credentials to settings"
```

---

### Task 7: Run integration regressions and final cleanup

**Files:**
- Verify: `src/openclaw-wizard.js`
- Verify: `src/openclaw-bridge.js`
- Verify: existing Telegram/Lark tests

- [ ] **Step 1: Run focused Lark SDK and routing tests**

Run:

```bash
npx vitest run \
  test/lark-api-client.test.js \
  test/lark-event-client.test.js \
  test/lark-bot.test.js \
  test/openclaw-wizard.test.js \
  test/openclaw-bridge.test.js \
  test/server.test.js \
  test/settings-drawer-lark-config.test.js \
  --pool=forks
```

Expected: PASS.

- [ ] **Step 2: Run Telegram regressions**

Run:

```bash
npx vitest run \
  test/telegram-config.route.test.js \
  test/telegram-bot.test.js \
  test/openclaw-hook.test.js \
  test/terminal-turn-notifications.test.js \
  --pool=forks
```

Expected: PASS. Telegram behavior remains unchanged.

- [ ] **Step 3: Run full suite with local excludes**

Run:

```bash
npm test -- --pool=forks --exclude "**/.worktrees/**" --exclude "**/.claude/**"
```

Expected: PASS. If `test/ai-terminal.route.test.js` fails only because of a hard-coded home path mismatch, record that as the known local environment issue and keep all Lark/Telegram focused tests green.

- [ ] **Step 4: Run Web build**

Run:

```bash
npm run build:web
```

Expected: PASS. Existing Vite chunk-size warnings are acceptable if no new errors appear.

- [ ] **Step 5: Confirm no runtime `lark-cli` dependency remains**

Run:

```bash
grep -R "lark-cli\|+messages-send\|+messages-reply\|event.*+subscribe" -n src test web/src package.json
```

Expected: no matches in runtime source. If historical docs mention `lark-cli`, leave docs unchanged unless the user asks for documentation updates.

- [ ] **Step 6: Commit verification-only cleanup if any files changed**

If Step 5 required code or test cleanup, commit it:

```bash
git add <changed-files>
git commit -m "test: verify lark sdk notification stack"
```

If no files changed, skip this commit.

---

## Self-Review

- Spec coverage: The plan covers SDK credentials, `Client` outbound messages, `WSClient` inbound long-connection events, secret masking, Web settings, restart behavior, and Telegram regression coverage.
- Placeholder scan: No step depends on unspecified implementation details; all new files and changed behavior include concrete code or exact assertions.
- Type consistency: The plan uses `appId`, `appSecret`, `appSecretMasked`, and `appSecretSource` consistently across backend config, API responses, Web types, and Settings UI.
- Scope check: This remains one cohesive runtime transport replacement. It does not add unrelated Lark app provisioning, docs publishing, or public webhook support.
