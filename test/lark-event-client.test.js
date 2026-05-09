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
