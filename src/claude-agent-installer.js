/**
 * Claude Code agent installer：
 *   - 写 ~/.claude.json 的 mcpServers.agentquad（带 _agentquadManaged 旁路 marker）
 *   - 装 ~/.claude/skills/agentquad-child/SKILL.md
 *
 * 跟 src/openclaw-hook-installer.js 风格保持一致 —— 都是改 ~/.claude.json。
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildMarker, isAgentquadManaged, writeJsonAtomic } from './agent-installer-shared.js'

const SKILL_NAME = 'agentquad-child'

function defaultClaudeJsonPath() {
  return join(homedir(), '.claude.json')
}

function defaultSkillsDir() {
  return join(homedir(), '.claude', 'skills')
}

function defaultSkillTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.skill.md', import.meta.url))
}

function readClaudeJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch (e) { throw new Error(`malformed_claude_json: ${e.message}`) }
}

export function installAgent({
  claudeJsonPath = defaultClaudeJsonPath(),
  skillsDir = defaultSkillsDir(),
  skillTemplatePath = defaultSkillTemplatePath(),
  port,
  version,
} = {}) {
  if (!port) throw new Error('port_required')
  if (!version) throw new Error('version_required')

  const changes = []
  const cur = readClaudeJson(claudeJsonPath)
  cur.mcpServers = cur.mcpServers || {}

  const desired = {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
  }
  const prev = cur.mcpServers.agentquad
  const prevMarker = cur._agentquadManaged
  const samePort = prev && prev.url === desired.url
  const sameVersion = prevMarker && prevMarker.version === version

  cur.mcpServers.agentquad = desired
  if (samePort && sameVersion && isAgentquadManaged(cur)) {
    // 保留旧 generatedAt，让 idempotent 写回不改 hash
    cur._agentquadManaged = prevMarker
  } else {
    cur._agentquadManaged = buildMarker({ version, port })
    changes.push('mcp_registered')
  }

  writeJsonAtomic(claudeJsonPath, cur)

  // skill
  const skillDir = join(skillsDir, SKILL_NAME)
  const skillFile = join(skillDir, 'SKILL.md')
  if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== readFileSync(skillTemplatePath, 'utf8')) {
    mkdirSync(skillDir, { recursive: true })
    copyFileSync(skillTemplatePath, skillFile)
    changes.push('skill_installed')
  }

  return { ok: true, changes, configPath: claudeJsonPath, skillPath: skillFile }
}

export function uninstallAgent({
  claudeJsonPath = defaultClaudeJsonPath(),
  skillsDir = defaultSkillsDir(),
} = {}) {
  const removed = []
  if (existsSync(claudeJsonPath)) {
    const cur = readClaudeJson(claudeJsonPath)
    if (cur.mcpServers?.agentquad) {
      delete cur.mcpServers.agentquad
      removed.push('mcp_entry')
    }
    if (cur._agentquadManaged) {
      delete cur._agentquadManaged
      removed.push('marker')
    }
    if (removed.length > 0) writeJsonAtomic(claudeJsonPath, cur)
  }
  const skillDir = join(skillsDir, SKILL_NAME)
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
    removed.push('skill')
  }
  return { ok: true, removed }
}

export function inspectAgent({
  claudeJsonPath = defaultClaudeJsonPath(),
  skillsDir = defaultSkillsDir(),
  expectedPort = null,
} = {}) {
  const out = {
    target: 'claude',
    mcpRegistered: false,
    skillPresent: false,
    drift: false,
    configPath: claudeJsonPath,
    expectedPort,
    actualPort: null,
    version: null,
  }
  if (existsSync(claudeJsonPath)) {
    try {
      const cur = readClaudeJson(claudeJsonPath)
      if (cur.mcpServers?.agentquad?.url) {
        out.mcpRegistered = true
        const m = cur.mcpServers.agentquad.url.match(/:(\d+)\//)
        if (m) out.actualPort = Number(m[1])
        out.version = cur._agentquadManaged?.version || null
      }
    } catch { /* malformed, treat as not registered */ }
  }
  if (existsSync(join(skillsDir, SKILL_NAME, 'SKILL.md'))) out.skillPresent = true
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
