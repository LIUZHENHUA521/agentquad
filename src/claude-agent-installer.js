/**
 * Claude Code agent installer：
 *   - 写 ~/.claude.json 的 mcpServers.agentquad（带 _agentquadManaged 旁路 marker）
 *   - 装 ~/.claude/skills/agentquad-child/SKILL.md（子任务委派）
 *   - 装 ~/.claude/skills/quadtodo-cli/SKILL.md（用 `quadtodo todo` CLI 管理待办）
 *
 * 跟 src/openclaw-hook-installer.js 风格保持一致 —— 都是改 ~/.claude.json。
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildMarker, isAgentquadManaged, writeJsonAtomic } from './agent-installer-shared.js'

// 主 skill（子任务委派）模板路径可被测试注入；其余随包内置 skill 走默认路径。
const SKILL_NAME = 'agentquad-child'

// 除主 skill 外随包附带的 skill。新增本地 skill 只要往这里加一项即可。
function bundledExtraSkills() {
  return [
    {
      name: 'quadtodo-cli',
      templatePath: fileURLToPath(new URL('./templates/agent-skills/quadtodo-cli.skill.md', import.meta.url)),
    },
  ]
}

function defaultClaudeJsonPath() {
  return join(homedir(), '.claude.json')
}

function defaultSkillsDir() {
  return join(homedir(), '.claude', 'skills')
}

function defaultSkillTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.skill.md', import.meta.url))
}

// 装一个 skill：内容有变（或不存在）才覆盖写，返回是否发生了写入。
function installOneSkill(skillsDir, name, templatePath) {
  const skillFile = join(skillsDir, name, 'SKILL.md')
  if (existsSync(skillFile) && readFileSync(skillFile, 'utf8') === readFileSync(templatePath, 'utf8')) {
    return { skillFile, changed: false }
  }
  mkdirSync(join(skillsDir, name), { recursive: true })
  copyFileSync(templatePath, skillFile)
  return { skillFile, changed: true }
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

  // skills：主 skill（模板可注入）+ 内置附带 skill
  const skillPaths = []
  const primary = installOneSkill(skillsDir, SKILL_NAME, skillTemplatePath)
  skillPaths.push(primary.skillFile)
  if (primary.changed) changes.push('skill_installed')
  for (const s of bundledExtraSkills()) {
    const r = installOneSkill(skillsDir, s.name, s.templatePath)
    skillPaths.push(r.skillFile)
    if (r.changed) changes.push(`skill_installed:${s.name}`)
  }

  return { ok: true, changes, configPath: claudeJsonPath, skillPath: primary.skillFile, skillPaths }
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
  for (const name of [SKILL_NAME, ...bundledExtraSkills().map(s => s.name)]) {
    const skillDir = join(skillsDir, name)
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true })
      removed.push(name === SKILL_NAME ? 'skill' : `skill:${name}`)
    }
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
  // skillPresent = 全部应装的 skill 都在；缺任一个就触发 bootstrap 补装（升级路径）
  const allSkills = [SKILL_NAME, ...bundledExtraSkills().map(s => s.name)]
  out.skillPresent = allSkills.every(name => existsSync(join(skillsDir, name, 'SKILL.md')))
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
