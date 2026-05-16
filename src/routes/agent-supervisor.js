/**
 * /api/agent-supervisor/* 路由：
 *   GET  /status      —— 当前配置 + 最近 audit
 *   POST /config      —— 部分更新配置（only 守望者字段）
 *   GET  /decisions   —— 分页 audit
 *
 * 配置写回走 saveConfig + withConfigLock 跟其它设置面板一致。
 * apiKey 输入永远不回显（描述里只给 hint，比如 sk-…abc1）。
 */
import { Router } from 'express'

const ALLOWED_KEYS = new Set([
  'enabled',
  'tool',
  'model',
  'timeoutMs',
  'threshold',
  'allowlist',
  'permissionAuto',
  'askUserAuto',
  'activePush',
  'browserControl',
])

export function createAgentSupervisorRouter({ db, supervisor, getConfig, saveConfig, withConfigLock }) {
  if (!db) throw new Error('db required')
  if (!supervisor) throw new Error('supervisor required')
  if (typeof getConfig !== 'function') throw new Error('getConfig required')
  if (typeof saveConfig !== 'function') throw new Error('saveConfig required')

  const router = Router()

  router.get('/status', (req, res) => {
    const desc = supervisor.describe()
    let recent = []
    try { recent = db.listAgentDecisions({ limit: 20 }) } catch { recent = [] }
    res.json({ ok: true, config: desc, recent })
  })

  router.post('/config', async (req, res) => {
    const patch = req.body && typeof req.body === 'object' ? req.body : {}
    const filtered = {}
    for (const [k, v] of Object.entries(patch)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v
    }
    try {
      const updated = await (withConfigLock
        ? withConfigLock(async () => {
            const cur = getConfig() || {}
            const next = {
              ...cur,
              agentSupervisor: {
                ...(cur.agentSupervisor || {}),
                ...filtered,
                // 嵌套对象浅合并
                activePush: {
                  ...(cur.agentSupervisor?.activePush || {}),
                  ...(filtered.activePush || {}),
                },
                browserControl: {
                  ...(cur.agentSupervisor?.browserControl || {}),
                  ...(filtered.browserControl || {}),
                },
              },
            }
            saveConfig(next)
            return next.agentSupervisor
          })
        : (() => {
            const cur = getConfig() || {}
            const next = {
              ...cur,
              agentSupervisor: {
                ...(cur.agentSupervisor || {}),
                ...filtered,
                activePush: { ...(cur.agentSupervisor?.activePush || {}), ...(filtered.activePush || {}) },
                browserControl: { ...(cur.agentSupervisor?.browserControl || {}), ...(filtered.browserControl || {}) },
              },
            }
            saveConfig(next)
            return next.agentSupervisor
          })())
      res.json({ ok: true, config: supervisor.describe() })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message || 'save_failed' })
    }
  })

  router.post('/reset-push-state', (req, res) => {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : ''
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'sessionId_required' })
    }
    try {
      supervisor.resetPushState?.(sessionId)
      res.json({ ok: true, sessionId, state: supervisor.getPushState?.(sessionId) || null })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.get('/decisions', (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : null
    const todoId = req.query.todoId ? String(req.query.todoId) : null
    try {
      const rows = db.listAgentDecisions({ limit, offset, sessionId, todoId })
      const total = db.countAgentDecisions({ sessionId, todoId })
      res.json({ ok: true, total, items: rows })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
