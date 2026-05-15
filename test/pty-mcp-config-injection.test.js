import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Inject a mock ptyFactory so PtyManager doesn't actually spawn
import { PtyManager } from '../src/pty.js'

function makePty({ tools }) {
  const ptyFactory = () => ({ onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} })
  const claudeSessionLocator = () => null
  return new PtyManager({ tools, ptyFactory, claudeSessionLocator })
}

describe('pty.create mcpConfigPath injection', () => {
  let dir, tools
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-pty-mcp-'))
    tools = {
      claude: { bin: 'claude', args: [] },
      codex: { bin: 'codex', args: [] },
      cursor: { bin: 'cursor', args: [] },
    }
  })

  it('claude: injects --mcp-config <path> when mcpConfigPath provided', () => {
    const mgr = makePty({ tools })
    const cfgPath = join(dir, 'mcp-test.json')
    writeFileSync(cfgPath, '{}')
    mgr.create({ sessionId: 's1', tool: 'claude', prompt: 'hi', cwd: dir, mcpConfigPath: cfgPath })
    const session = mgr.sessions.get('s1')
    const args = session.spawnSpec.args
    const idx = args.indexOf('--mcp-config')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe(cfgPath)
  })

  it('claude: no --mcp-config flag when mcpConfigPath not provided', () => {
    const mgr = makePty({ tools })
    mgr.create({ sessionId: 's2', tool: 'claude', prompt: 'hi', cwd: dir })
    const session = mgr.sessions.get('s2')
    expect(session.spawnSpec.args).not.toContain('--mcp-config')
  })

  it('codex: does NOT inject --mcp-config (deferred to Task 11)', () => {
    const mgr = makePty({ tools })
    mgr.create({ sessionId: 's3', tool: 'codex', prompt: 'hi', cwd: dir, mcpConfigPath: join(dir, 'x.toml') })
    const session = mgr.sessions.get('s3')
    expect(session.spawnSpec.args).not.toContain('--mcp-config')
  })
})
