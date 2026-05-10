import { Router } from 'express'

/**
 * POST /api/openclaw/hook
 *   body: { source?, path?, event, sessionId, targetUserId?, todoId?, todoTitle?, hookPayload?,
 *           nativeId?, transcript_path?, cwd?, raw_event_payload?, promptText?, matchedPattern? }
 *
 * Claude Code hook 脚本（~/.quadtodo/claude-hooks/notify.js）调用此端点（默认 source=claude）。
 * Codex 事件来源（jsonl emitter / detector）也走同一端点，通过 source/path 字段区分。
 * 端到端逻辑都委托给 openclaw-hook handler，路由层只做 body 校验与字段转发。
 */
export function createOpenClawHookRouter({ hookHandler } = {}) {
  if (!hookHandler) throw new Error('hookHandler required')
  const router = Router()

  router.post('/', async (req, res) => {
    try {
      const {
        source = 'claude',
        path = null,
        event,
        sessionId,
        nativeId,
        targetUserId,
        todoId,
        todoTitle,
        hookPayload,
        transcript_path,
        cwd,
        raw_event_payload,
        promptText,
        matchedPattern,
      } = req.body || {}

      if (source === 'codex' && path !== 'jsonl' && path !== 'detector') {
        return res.status(400).json({ ok: false, error: 'unsupported_body_shape' })
      }

      if (!event || typeof event !== 'string') {
        return res.status(400).json({ ok: false, error: 'event_required' })
      }

      const result = await hookHandler.handle({
        source,
        path,
        event,
        sessionId: sessionId || null,
        nativeId: nativeId || null,
        todoId: todoId || null,
        todoTitle: todoTitle || null,
        targetUserId: targetUserId || null,
        hookPayload: hookPayload || null,
        transcript_path: transcript_path || null,
        cwd: cwd || null,
        raw_event_payload: raw_event_payload || null,
        promptText: promptText || null,
        matchedPattern: matchedPattern || null,
      })

      return res.json({ ok: result.ok, ...result })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message || 'hook_handle_failed' })
    }
  })

  return router
}
