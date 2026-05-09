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
