import * as Lark from '@larksuiteoapi/node-sdk'
import { toLarkText } from './lark-markdown.js'

function isBlank(value) {
  return value == null || String(value) === ''
}

function normalizePayload(response) {
  return response?.data || response || null
}

function normalizeError(error) {
  // 飞书 SDK 把 axios 错误抛出来，response.data 里有 {code, msg} 是真正的业务错误。
  // 优先把它捞出来 —— "code 231001: reaction type is invalid" 比 "Request failed with
  // status code 400" 有用得多。
  const data = error?.response?.data
  if (data && typeof data === 'object') {
    const parts = []
    if (data.code != null) parts.push(`code ${data.code}`)
    if (data.msg) parts.push(data.msg)
    if (parts.length) return parts.join(': ')
  }
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
          content: JSON.stringify({ text: toLarkText(String(text)) }),
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
          content: JSON.stringify({ text: toLarkText(String(text)) }),
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

  async function sendCard({ chatId, card } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(chatId)) return { ok: false, reason: 'chatId_required' }
    if (!card || typeof card !== 'object') return { ok: false, reason: 'card_required' }
    try {
      const response = await getClient().im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: String(chatId),
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] sendCard failed: ${detail}`)
      return { ok: false, reason: 'lark_send_card_failed', detail }
    }
  }

  async function replyWithCard({ rootMessageId, card } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(rootMessageId)) return { ok: false, reason: 'rootMessageId_required' }
    if (!card || typeof card !== 'object') return { ok: false, reason: 'card_required' }
    try {
      const response = await getClient().im.message.reply({
        path: { message_id: String(rootMessageId) },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: true,
        },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] replyCard failed: ${detail}`)
      return { ok: false, reason: 'lark_reply_card_failed', detail }
    }
  }

  async function addReaction({ messageId, emojiType } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(messageId)) return { ok: false, reason: 'messageId_required' }
    if (isBlank(emojiType)) return { ok: false, reason: 'emojiType_required' }
    try {
      const response = await getClient().im.messageReaction.create({
        path: { message_id: String(messageId) },
        data: { reaction_type: { emoji_type: String(emojiType) } },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] reaction failed: ${detail}`)
      return { ok: false, reason: 'lark_reaction_failed', detail }
    }
  }

  async function deleteReaction({ messageId, reactionId } = {}) {
    if (!hasCredentials()) return { ok: false, reason: 'lark_credentials_missing' }
    if (isBlank(messageId)) return { ok: false, reason: 'messageId_required' }
    if (isBlank(reactionId)) return { ok: false, reason: 'reactionId_required' }
    try {
      const response = await getClient().im.messageReaction.delete({
        path: { message_id: String(messageId), reaction_id: String(reactionId) },
      })
      return { ok: true, payload: normalizePayload(response) }
    } catch (e) {
      const detail = normalizeError(e)
      logger.warn?.(`[lark-api] reaction delete failed: ${detail}`)
      return { ok: false, reason: 'lark_reaction_delete_failed', detail }
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

  return { sendMessage, replyInThread, sendCard, replyWithCard, addReaction, deleteReaction, testConnection }
}
