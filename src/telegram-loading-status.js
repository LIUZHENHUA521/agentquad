/**
 * 只做一件事：在 PTY session **终态** 时改 telegram topic 标题前缀。
 *
 *   done     → ✅ <name>      （PTY exit 0）
 *   failed   → ❌ <name>      （PTY exit ≠ 0）
 *   stopped  → ⏹ <name>      （用户主动 stop）
 *
 * running / idle 状态由 src/telegram-reaction-tracker.js 通过给用户消息加/删
 * ✍ reaction 表达 —— 那条路径粒度更细、节流压力更小，留这里只管终态。
 *
 * 限速防御：
 *   - 全局 backoff（429）保留，但终态硬上，不受 backoff 影响 —— ✅/❌/⏹
 *     是用户最在意的状态，必须显示。
 *
 * 为了向后兼容，markIdle / markRunning / start 接口保留但 running/idle 改为 no-op。
 */

const TITLE_PREFIX_BY_PHASE = {
  done:    '✅ ',
  failed:  '❌ ',
  stopped: '⏹ ',
}

const TERMINAL_PHASES = new Set(['done', 'failed', 'stopped'])

/**
 * @param {object} opts
 * @param opts.telegramBot { editForumTopic({chatId,threadId,name}) }
 * @param opts.openclaw    { resolveRoute(sessionId) → {targetUserId, threadId, topicName} | null }
 * @param opts.logger
 * @param opts.now         可注入时钟（测试用）
 */
export function createLoadingTracker({
  telegramBot,
  openclaw,
  logger = console,
  now = () => Date.now(),
  getConfig = null,
} = {}) {
  if (!telegramBot) throw new Error('telegramBot_required')
  void now; void getConfig

  // sessionId → { chatId, threadId, originalTopicName }
  const sessions = new Map()

  function parseRetryAfter(desc) {
    const m = String(desc || '').match(/retry after (\d+)/i)
    return m ? Number(m[1]) : 0
  }

  async function renameTerminal(state, phase) {
    if (!telegramBot.editForumTopic || !state.originalTopicName) return
    const prefix = TITLE_PREFIX_BY_PHASE[phase]
    if (!prefix) return
    const newName = (prefix + state.originalTopicName).slice(0, 128)
    try {
      await telegramBot.editForumTopic({
        chatId: state.chatId,
        threadId: state.threadId,
        name: newName,
      })
    } catch (e) {
      const desc = e?.description || e?.message || ''
      const retryAfter = parseRetryAfter(desc) || (e?.parameters?.retry_after) || 0
      if (/too many requests|429/i.test(desc) || retryAfter > 0) {
        // 终态硬上：不再阻塞下一次终态 rename，仅 log
        logger.warn?.(`[loading-status] terminal rename hit 429 sid=${state.sessionId} retry_after=${retryAfter || '?'}s`)
        return
      }
      if (!/not[ _]modified/i.test(desc)) {
        logger.warn?.(`[loading-status] editForumTopic phase=${phase} failed sid=${state.sessionId}: ${desc}`)
      }
    }
  }

  /**
   * 注册 session（PTY native-session 时 server.js 调）。不再发任何 rename，
   * 只把 originalTopicName 记下来给后续 stop 用。
   * skipTitleRename 现在不影响行为（保留参数避免破坏 caller）。
   */
  async function start({ sessionId, skipTitleRename = false } = {}) {
    if (!sessionId || sessions.has(sessionId)) return
    void skipTitleRename
    const route = openclaw?.resolveRoute?.(sessionId, 'telegram')
    if (!route?.threadId) return
    if (!route.topicName) return
    sessions.set(sessionId, {
      sessionId,
      chatId: String(route.targetUserId),
      threadId: route.threadId,
      originalTopicName: route.topicName,
    })
  }

  // running / idle 由 reaction-tracker 处理；这两个接口保留向后兼容，但改为 no-op
  async function markIdle(_sessionId) { /* no-op */ }
  async function markRunning(_sessionId) { /* no-op */ }

  async function stop({ sessionId, finalStatus = 'done' } = {}) {
    const state = sessions.get(sessionId)
    if (!state) return
    sessions.delete(sessionId)
    if (TERMINAL_PHASES.has(finalStatus)) {
      await renameTerminal(state, finalStatus)
    }
  }

  function has(sessionId) { return sessions.has(sessionId) }
  function size() { return sessions.size }

  return { start, stop, markIdle, markRunning, has, size, __test__: { sessions } }
}
