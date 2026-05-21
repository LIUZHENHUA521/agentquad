/**
 * Per-agent raw config-file editor.
 *   GET  /api/agent-config/:tool          → 列出该 agent 的可编辑配置文件（白名单制）
 *   GET  /api/agent-config/:tool/file?id  → 读取单个文件原文
 *   PUT  /api/agent-config/:tool/file     body: { id, content } → 写回，写前自动备份
 *
 * 白名单写死：只允许编辑 Claude / Codex / Cursor 在 ~/. 下的标准配置文件，避免
 * 把整张磁盘暴露出去。每次写入都生成 `<file>.bak.<ts>` 备份，JSON 文件在保存前
 * 强制 parse 校验语法，TOML 不强校验。
 */
import { Router } from 'express'
import { existsSync, readFileSync, statSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileAtomic } from '../agent-installer-shared.js'

const MAX_BYTES = 2 * 1024 * 1024  // 2MB 上限，config 文件不可能更大

// 每个工具暴露的文件白名单。id 必须稳定（前端会引用）。路径用 getter 延迟计算，
// 这样测试可以通过 process.env.HOME 把根目录隔到 tmp 里。
function buildToolFiles(home = homedir()) {
  return {
    claude: [
      { id: 'settings', label: '~/.claude/settings.json', path: join(home, '.claude', 'settings.json'), format: 'json' },
      { id: 'mcp', label: '~/.claude.json (MCP servers)', path: join(home, '.claude.json'), format: 'json' },
    ],
    codex: [
      { id: 'config', label: '~/.codex/config.toml', path: join(home, '.codex', 'config.toml'), format: 'toml' },
      { id: 'hooks', label: '~/.codex/hooks.json', path: join(home, '.codex', 'hooks.json'), format: 'json' },
    ],
    cursor: [
      { id: 'mcp', label: '~/.cursor/mcp.json', path: join(home, '.cursor', 'mcp.json'), format: 'json' },
      { id: 'hooks', label: '~/.cursor/hooks.json', path: join(home, '.cursor', 'hooks.json'), format: 'json' },
      { id: 'cli', label: '~/.cursor/cli-config.json', path: join(home, '.cursor', 'cli-config.json'), format: 'json' },
    ],
  }
}

function fileMeta(entry) {
  const meta = { id: entry.id, label: entry.label, path: entry.path, format: entry.format, exists: false, size: 0, mtime: 0 }
  try {
    if (existsSync(entry.path)) {
      const st = statSync(entry.path)
      if (st.isFile()) {
        meta.exists = true
        meta.size = st.size
        meta.mtime = Math.round(st.mtimeMs)
      }
    }
  } catch { /* swallow */ }
  return meta
}

function lookup(toolFiles, tool, id) {
  const list = toolFiles[tool]
  if (!list) return null
  return list.find(e => e.id === id) || null
}

function backupFile(path) {
  if (!existsSync(path)) return null
  const bak = `${path}.bak.${Date.now()}`
  try { copyFileSync(path, bak); return bak } catch { return null }
}

export function createAgentConfigRouter({ logger = console, getHome = () => homedir() } = {}) {
  const router = Router()

  router.get('/:tool', (req, res) => {
    const tool = req.params.tool
    const toolFiles = buildToolFiles(getHome())
    const list = toolFiles[tool]
    if (!list) return res.status(404).json({ ok: false, error: 'unknown_tool' })
    res.json({ ok: true, tool, files: list.map(fileMeta) })
  })

  router.get('/:tool/file', (req, res) => {
    const tool = req.params.tool
    const id = String(req.query.id || '')
    const toolFiles = buildToolFiles(getHome())
    const entry = lookup(toolFiles, tool, id)
    if (!entry) return res.status(404).json({ ok: false, error: 'unknown_file' })
    if (!existsSync(entry.path)) {
      return res.json({ ok: true, ...fileMeta(entry), content: '' })
    }
    try {
      const st = statSync(entry.path)
      if (st.size > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: 'file_too_large', limitMB: 2 })
      }
      const content = readFileSync(entry.path, 'utf8')
      res.json({ ok: true, ...fileMeta(entry), content })
    } catch (e) {
      logger.warn?.(`[agent-config] read failed: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message || 'read_failed' })
    }
  })

  router.put('/:tool/file', (req, res) => {
    const tool = req.params.tool
    const { id, content } = req.body || {}
    const toolFiles = buildToolFiles(getHome())
    const entry = lookup(toolFiles, tool, String(id || ''))
    if (!entry) return res.status(404).json({ ok: false, error: 'unknown_file' })
    if (typeof content !== 'string') {
      return res.status(400).json({ ok: false, error: 'content_required' })
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'file_too_large', limitMB: 2 })
    }
    if (entry.format === 'json' && content.trim()) {
      try { JSON.parse(content) } catch (e) {
        return res.status(400).json({ ok: false, error: 'invalid_json', detail: e.message })
      }
    }
    try {
      mkdirSync(dirname(entry.path), { recursive: true })
      const backup = backupFile(entry.path)
      writeFileAtomic(entry.path, content)
      logger.info?.(`[agent-config] wrote ${entry.path}${backup ? ` (backup ${backup})` : ''}`)
      res.json({ ok: true, ...fileMeta(entry), backup })
    } catch (e) {
      logger.warn?.(`[agent-config] write failed: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message || 'write_failed' })
    }
  })

  return router
}

// 暴露白名单生成器，便于测试断言路径白名单
export { buildToolFiles }
