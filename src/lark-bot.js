import { createLarkApiClient } from './lark-api-client.js'
import { createLarkEventClient } from './lark-event-client.js'

function isBlank(value) {
  return value == null || String(value) === ''
}

function stripMentionKeys(text, mentions) {
  if (!text || typeof text !== 'string') return text || ''
  if (!Array.isArray(mentions) || mentions.length === 0) return text
  let out = text
  for (const m of mentions) {
    const key = m?.key
    if (!key || typeof key !== 'string') continue
    // 例如 "@_user_1"。占位符通常前后有空格，这里把 "<key> " / " <key>" / "<key>" 都替成空。
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(escaped + '\\s*', 'g'), '')
  }
  return out
}

// 飞书 post 富文本：content.content 是 [[node, node, ...], [node, ...], ...]，
// node.tag 可能是 'text' / 'at' / 'a'(超链接) / 'img' / 'emotion' 等。
// 提取所有可见文字节点（text / a 的 text / md 的 text），跳过 at(就是要剥的 @ 占位)。
function extractPostText(post) {
  if (!post || typeof post !== 'object') return ''
  const lines = Array.isArray(post.content) ? post.content : []
  const out = []
  for (const line of lines) {
    if (!Array.isArray(line)) continue
    let buf = ''
    for (const node of line) {
      if (!node || typeof node !== 'object') continue
      const tag = node.tag
      if (tag === 'text' || tag === 'a' || tag === 'md') {
        if (typeof node.text === 'string') buf += node.text
      }
    }
    if (buf) out.push(buf)
  }
  const body = out.join('\n').trim()
  if (body) return body
  if (typeof post.title === 'string' && post.title.trim()) return post.title.trim()
  return ''
}

export function extractText(message = {}) {
  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = {} }
  }
  if (!content || typeof content !== 'object') return ''
  // 1. 普通 text 消息
  if (typeof content.text === 'string' && content.text) {
    return stripMentionKeys(content.text, message.mentions).replace(/^\s+/, '').trim()
  }
  // 2. post 富文本（@bot 的消息也是这种格式）
  if (Array.isArray(content.content)) {
    return extractPostText(content).trim()
  }
  // 3. 老的 title-only 兜底
  if (typeof content.title === 'string') {
    return stripMentionKeys(content.title, message.mentions).replace(/^\s+/, '').trim()
  }
  return ''
}

export function rememberSeen(seen, key, max = 500) {
  if (!key || seen.has(key)) return false
  seen.set(key, Date.now())
  while (seen.size > max) {
    let oldestKey
    let oldestTime = Infinity
    for (const [seenKey, timestamp] of seen.entries()) {
      if (timestamp < oldestTime) {
        oldestKey = seenKey
        oldestTime = timestamp
      }
    }
    if (oldestKey == null) break
    seen.delete(oldestKey)
  }
  return true
}

function stringOrNull(value) {
  return value == null ? null : String(value)
}

export function normalizeEvent(raw = {}) {
  const event = raw.event || raw
  const message = event.message || {}
  const sender = event.sender || {}
  const messageId = stringOrNull(message.message_id || message.messageId)
  return {
    eventId: stringOrNull(raw.event_id || raw.eventId || messageId),
    chatId: stringOrNull(message.chat_id || message.chatId),
    messageId,
    threadId: stringOrNull(message.thread_id || message.threadId),
    rootMessageId: stringOrNull(message.root_id || message.rootId || message.parent_id || message.parentId),
    text: extractText(message),
    fromUserId: stringOrNull(sender.sender_id?.open_id || sender.sender_id?.user_id || sender.open_id),
    senderType: sender.sender_type || sender.type || null,
  }
}

export function createLarkBot({
  getConfig,
  wizard,
  apiClientFactory = createLarkApiClient,
  eventClientFactory = createLarkEventClient,
  logger = console,
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')
  if (!wizard || typeof wizard.handleInbound !== 'function') throw new Error('wizard_required')

  const seenEvents = new Map()
  const pendingReplyRetries = new Map()
  let running = false
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

  async function addReaction({ messageId, emojiType = 'EYES' } = {}) {
    if (isBlank(messageId)) return { ok: false, reason: 'messageId_required' }
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    return getApiClient().addReaction({ messageId, emojiType })
  }

  // thread root 被撤回 / 飞书 5xx 时，回退到 chat-level sendMessage，避免 bot 完全沉默。
  // 兜底仅当 chatId 可用时启用；纯 reply 没有 chatId 的话就保留原失败语义。
  async function deliverReply({ chatId, rootMessageId, text } = {}) {
    if (!rootMessageId) return sendMessage({ chatId, text })
    const r = await replyInThread({ rootMessageId, text })
    if (r?.ok) return r
    if (chatId && r?.reason === 'lark_reply_failed') {
      logger.warn?.(`[lark-bot] reply failed (${r.detail || 'unknown'}); fallback to chat sendMessage`)
      const fb = await sendMessage({ chatId, text })
      if (fb?.ok) return { ...fb, replyFallback: true }
      return r
    }
    return r
  }

  function clearPendingReplyRetry(replyContext, ev) {
    const keys = new Set([
      ...(replyContext?.retryKeys || []),
      ev.eventId,
      ev.messageId,
    ].filter(Boolean))
    for (const key of keys) pendingReplyRetries.delete(key)
  }

  function replyFailureResult(replyResult, reason = null) {
    return {
      ok: false,
      reason: reason || replyResult?.reason || 'reply_failed',
      detail: replyResult?.detail,
    }
  }

  async function handleEvent(raw) {
    const ev = normalizeEvent(raw)
    if (!ev.eventId) {
      return { ok: true, action: 'duplicate' }
    }

    const pendingReplyRetry = pendingReplyRetries.get(ev.eventId) || (ev.messageId ? pendingReplyRetries.get(ev.messageId) : null)
    if (pendingReplyRetry) {
      const retryResult = await deliverReply(pendingReplyRetry)
      if (!retryResult?.ok) {
        return replyFailureResult(retryResult, 'reply_retry_failed')
      }
      clearPendingReplyRetry(pendingReplyRetry, ev)
      return { ok: true, action: pendingReplyRetry.action || 'handled' }
    }

    if (seenEvents.has(ev.eventId) || (ev.messageId && seenEvents.has(ev.messageId))) {
      return { ok: true, action: 'duplicate' }
    }
    rememberSeen(seenEvents, ev.eventId)
    if (ev.messageId && ev.messageId !== ev.eventId) rememberSeen(seenEvents, ev.messageId)
    const forgetEvent = () => {
      seenEvents.delete(ev.eventId)
      if (ev.messageId && ev.messageId !== ev.eventId) seenEvents.delete(ev.messageId)
    }

    const configuredChatId = getConfig()?.lark?.chatId
    if (configuredChatId && ev.chatId !== String(configuredChatId)) {
      logger.warn?.(`[lark-bot] ignored_chat: event chatId=${ev.chatId} != configured ${configuredChatId} (eventId=${ev.eventId})`)
      return { ok: true, action: 'ignored_chat' }
    }
    if (ev.senderType === 'app' || ev.senderType === 'bot') {
      logger.info?.(`[lark-bot] ignored_self: senderType=${ev.senderType} (eventId=${ev.eventId})`)
      return { ok: true, action: 'ignored_self' }
    }
    if (isBlank(ev.text)) {
      const rawMsg = raw?.event?.message || raw?.message || {}
      const msgType = rawMsg.msg_type || rawMsg.message_type || '(unknown)'
      const contentRaw = typeof rawMsg.content === 'string' ? rawMsg.content : JSON.stringify(rawMsg.content || {})
      const mentions = JSON.stringify(rawMsg.mentions || [])
      logger.warn?.(`[lark-bot] ignored_empty: no text (eventId=${ev.eventId} msg_type=${msgType} content=${contentRaw.slice(0, 240)} mentions=${mentions.slice(0, 240)})`)
      return { ok: true, action: 'ignored_empty' }
    }
    logger.info?.(`[lark-bot] dispatching to wizard: chatId=${ev.chatId} thread=${ev.threadId || '-'} root=${ev.rootMessageId || '-'} text="${(ev.text || '').slice(0, 80)}"`)

    // 立即加 👀 reaction 让用户知道 bot 看到了 / 在干活；不 await，避免拖慢 wizard
    if (ev.messageId && hasCredentials()) {
      getApiClient().addReaction({ messageId: ev.messageId, emojiType: 'EYES' })
        .catch((e) => logger.warn?.(`[lark-bot] reaction failed: ${e.message}`))
    }

    let result
    try {
      result = await wizard.handleInbound({
        channel: 'lark',
        chatId: ev.chatId,
        threadId: ev.threadId,
        rootMessageId: ev.rootMessageId,
        messageId: ev.messageId,
        text: ev.text,
        fromUserId: ev.fromUserId,
      })
    } catch (e) {
      forgetEvent()
      return { ok: false, reason: 'wizard_failed', detail: e.message }
    }

    const action = result?.action || 'handled'
    if (result?.reply) {
      // 优先 reply 进用户当前所在的 thread：
      //   - rootMessageId（用户在已有 thread 里发的回复）
      //   - 退而求其次用 messageId（用户在新建话题里发第一条消息，没 root_id；
      //     用 reply API 直接回那条消息可让飞书把 reply 显示在同一个话题里）
      const replyTarget = ev.rootMessageId || ev.messageId || null
      const replyContext = {
        chatId: ev.chatId,
        rootMessageId: replyTarget,
        text: result.reply,
        action,
        retryKeys: [ev.eventId, ev.messageId].filter(Boolean),
      }
      const replyResult = await deliverReply(replyContext)
      if (!replyResult?.ok) {
        pendingReplyRetries.set(ev.eventId, replyContext)
        if (ev.messageId && ev.messageId !== ev.eventId) pendingReplyRetries.set(ev.messageId, replyContext)
        return replyFailureResult(replyResult)
      }
    }

    return { ok: true, action }
  }

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

  return { start, stop, sendMessage, replyInThread, handleEvent, describe, __test__: { normalizeEvent } }
}
