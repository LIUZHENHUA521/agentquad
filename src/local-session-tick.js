// Codex local sessions don't get a SessionEnd hook. Use the most recent Stop
// + a quiet window to call them "done" without waiting for the process to die.

const DEFAULT_CODEX_SILENT_TIMEOUT_MS = 30 * 60 * 1000

export function runLocalSessionTick({ db, now = Date.now(), logger, timeoutMs = DEFAULT_CODEX_SILENT_TIMEOUT_MS } = {}) {
  if (!db) return
  const todos = db.listTodos({})
  for (const todo of todos) {
    const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []
    for (const s of sessions) {
      if (s.tool !== 'codex') continue
      if (s.source !== 'local-capture' && s.source !== 'adopted') continue
      if (s.status !== 'idle') continue
      if (!s.lastStopAt) continue
      if (now - s.lastStopAt < timeoutMs) continue
      db.setAiSessionFields(todo.id, s.sessionId, {
        status: 'done',
        completedAt: now
      })
      logger?.info?.({ todoId: todo.id, sessionId: s.sessionId }, 'codex local session timed out')
    }
  }
}

export function startLocalSessionTick({ db, intervalMs = 60_000, logger, timeoutMs } = {}) {
  const handle = setInterval(() => {
    try { runLocalSessionTick({ db, logger, timeoutMs }) }
    catch (e) { logger?.error?.({ err: e }, 'local-session-tick error') }
  }, intervalMs)
  if (typeof handle.unref === 'function') handle.unref()
  return () => clearInterval(handle)
}
