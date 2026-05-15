import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgent,
  uninstallAgent,
  inspectAgent,
} from '../src/claude-agent-installer.js'

describe('claude-agent-installer', () => {
  let dir, claudeJsonPath, skillsDir, skillTemplatePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-claude-agent-'))
    claudeJsonPath = join(dir, '.claude.json')
    skillsDir = join(dir, '.claude', 'skills')
    skillTemplatePath = join(dir, 'skill-template.md')
    writeFileSync(skillTemplatePath, '# fake skill content\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates ~/.claude.json with mcpServers.agentquad + _agentquadManaged marker', () => {
    const r = installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    expect(r.ok).toBe(true)
    expect(r.changes).toContain('mcp_registered')
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad.url).toBe('http://127.0.0.1:5677/mcp')
    expect(j._agentquadManaged.version).toBe('0.4.0')
    expect(j._agentquadManaged.port).toBe(5677)
  })

  it('writes skill file to skillsDir/agentquad-child/SKILL.md', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    expect(existsSync(join(skillsDir, 'agentquad-child', 'SKILL.md'))).toBe(true)
  })

  it('preserves user-defined mcpServers entries', () => {
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }))
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.other.url).toBe('http://x')
    expect(j.mcpServers.agentquad).toBeDefined()
  })

  it('idempotent — re-install with same port yields identical file', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const a = readFileSync(claudeJsonPath, 'utf8')
    // 故意微调 generatedAt 不计入 idempotence —— 实现里 same port+version 应保留旧 generatedAt
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const b = readFileSync(claudeJsonPath, 'utf8')
    expect(b).toBe(a)
  })

  it('updates port automatically on re-install with different port', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5678, version: '0.4.0' })
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad.url).toBe('http://127.0.0.1:5678/mcp')
    expect(j._agentquadManaged.port).toBe(5678)
  })

  it('uninstall removes mcpServers.agentquad + marker + skill, keeps other mcpServers', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    // 用户事后手加一个 other entry
    const cur = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    cur.mcpServers.other = { url: 'http://x' }
    writeFileSync(claudeJsonPath, JSON.stringify(cur))
    uninstallAgent({ claudeJsonPath, skillsDir })
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad).toBeUndefined()
    expect(j._agentquadManaged).toBeUndefined()
    expect(j.mcpServers.other.url).toBe('http://x')
    expect(existsSync(join(skillsDir, 'agentquad-child'))).toBe(false)
  })

  it('inspect reports installed=true and drift=true when port mismatch', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const a = inspectAgent({ claudeJsonPath, skillsDir, expectedPort: 5677 })
    expect(a.mcpRegistered).toBe(true)
    expect(a.skillPresent).toBe(true)
    expect(a.drift).toBe(false)

    const b = inspectAgent({ claudeJsonPath, skillsDir, expectedPort: 9999 })
    expect(b.drift).toBe(true)
  })
})
