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

  it('codex: does NOT inject --mcp-config (uses --config K=V instead)', () => {
    const mgr = makePty({ tools })
    mgr.create({ sessionId: 's3', tool: 'codex', prompt: 'hi', cwd: dir, mcpConfigPath: join(dir, 'x.toml') })
    const session = mgr.sessions.get('s3')
    expect(session.spawnSpec.args).not.toContain('--mcp-config')
  })

  it('codex: injects --config mcp_servers.agentquad.url=... when codexMcpUrl provided', () => {
    const mgr = makePty({ tools })
    mgr.create({ sessionId: 's4', tool: 'codex', prompt: 'hi', cwd: dir, codexMcpUrl: 'http://127.0.0.1:5678/mcp' })
    const session = mgr.sessions.get('s4')
    const args = session.spawnSpec.args
    // Should contain `-c` twice followed by KV expressions
    const cIndexes = args.map((a, i) => a === '-c' ? i : -1).filter(i => i >= 0)
    expect(cIndexes.length).toBe(2)
    expect(args[cIndexes[0] + 1]).toBe('mcp_servers.agentquad.url="http://127.0.0.1:5678/mcp"')
    expect(args[cIndexes[1] + 1]).toBe('mcp_servers.agentquad.transport="http"')
  })

  it('codex: no -c flag when codexMcpUrl absent', () => {
    const mgr = makePty({ tools })
    mgr.create({ sessionId: 's5', tool: 'codex', prompt: 'hi', cwd: dir })
    const session = mgr.sessions.get('s5')
    expect(session.spawnSpec.args).not.toContain('-c')
  })
})
