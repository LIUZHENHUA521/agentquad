/**
 * Session Input Dispatcher
 *
 * 所有 "把用户文本投递到一个 Claude Code session" 的路径都走这里。
 * 三档语义：
 *   - queue_or_send  ：普通文本，busy 时入队，idle 时直发
 *   - soft_interrupt ：`!` 前缀，busy 时 Esc → 250ms 后投递新文本，丢弃旧队列
 *   - hard_cancel    ：`!!` 前缀 或精确 `/stop`，busy 时 Ctrl+C，不投递文本
 */

const QUEUE_LIMIT = 20
const STALE_MS = 5 * 60 * 1000
const SOFT_INTERRUPT_DELAY_MS = 250

export function parseTrigger(rawText) {
  const text = String(rawText || '').trim()
  if (text === '/stop') return { mode: 'hard_cancel', stripped: '' }
  if (text.startsWith('!!')) return { mode: 'hard_cancel', stripped: '' }
  if (text.startsWith('!')) return { mode: 'soft_interrupt', stripped: text.slice(1).trim() }
  return { mode: 'queue_or_send', stripped: text }
}

function buildPayload(text, imagePaths) {
  if (!imagePaths || imagePaths.length === 0) return text
  const ats = imagePaths.map((p) => `@${p}`).join(' ')
  return text ? `${ats} ${text}` : ats
}

function writeToPty(pty, sessionId, payload, logger) {
  pty.write(sessionId, payload)
  setTimeout(() => {
    try { pty.write(sessionId, '\r') } catch (e) {
      logger?.warn?.(`[dispatcher] submit \\r failed sid=${sessionId}: ${e.message}`)
    }
  }, 80)
}

export function createSessionInputDispatcher({ pty, aiTerminal, callbacks = {}, logger = console } = {}) {
  if (!pty) throw new Error('pty_required')
  if (!aiTerminal) throw new Error('aiTerminal_required')

  // sessionId → QueueState
  const queues = new Map()

  async function send({ sessionId, text, imagePaths = [], channel, echoTarget } = {}) {
    if (!pty.has(sessionId)) {
      return { action: 'session_ended', sessionId }
    }
    const { mode, stripped } = parseTrigger(text)
    const idle = aiTerminal.isSessionAwaitingReply(sessionId)

    if (idle) {
      if (mode === 'hard_cancel') {
        return { action: 'noop_idle', sessionId }
      }
      // queue_or_send / soft_interrupt 在 idle 下都等同直发 stripped
      const payload = buildPayload(stripped, imagePaths)
      writeToPty(pty, sessionId, payload, logger)
      return { action: 'sent', sessionId }
    }

    // busy 路径在后续 task 实现
    return { action: 'noop', reason: 'busy_not_implemented_yet', sessionId }
  }

  function onSessionIdle(_sessionId) { /* TODO Task 5 */ }
  function onSessionEnd(_sessionId) { /* TODO Task 8 */ }
  function describe() { return { sessions: 0 } }

  return { send, onSessionIdle, onSessionEnd, describe, __test__: { queues, parseTrigger } }
}
