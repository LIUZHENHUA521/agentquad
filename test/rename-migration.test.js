// test/rename-migration.test.js
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('migrateLegacyHomeDirIfNeeded', () => {
  let home
  let stderrBuf
  const stderr = { write: (s) => { stderrBuf += s } }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentquad-test-'))
    stderrBuf = ''
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('migrates legacy dir to new dir and writes marker', async () => {
    const oldDir = join(home, '.quadtodo')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'x')
    writeFileSync(join(oldDir, 'config.json'), JSON.stringify({ wiki: { wikiDir: join(home, '.quadtodo', 'wiki') } }))

    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })

    expect(result.action).toBe('migrated')
    expect(existsSync(join(home, '.agentquad', 'data.db'))).toBe(true)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(home, '.agentquad', '.migrated-from-quadtodo'))).toBe(true)
    const cfg = JSON.parse(readFileSync(join(home, '.agentquad', 'config.json'), 'utf8'))
    expect(cfg.wiki.wikiDir).toBe(join(home, '.agentquad', 'wiki'))
    expect(stderrBuf).toMatch(/migrated/i)
  })

  it('is a no-op when new dir already exists', async () => {
    mkdirSync(join(home, '.agentquad'), { recursive: true })
    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })
    expect(result.action).toBe('skip')
    expect(result.reason).toBe('new-exists')
  })

  it('emits hint when both old and new dirs exist', async () => {
    mkdirSync(join(home, '.agentquad'), { recursive: true })
    mkdirSync(join(home, '.quadtodo'), { recursive: true })
    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })
    expect(result.action).toBe('skip')
    expect(stderrBuf).toMatch(/legacy.*ignoring/i)
    expect(existsSync(join(home, '.quadtodo'))).toBe(true)
  })

  it('aborts when legacy service is still running', async () => {
    const oldDir = join(home, '.quadtodo')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'x')
    writeFileSync(join(oldDir, 'quadtodo.pid'), '12345')

    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => true })

    expect(result.action).toBe('abort')
    expect(result.reason).toBe('pid-alive')
    expect(existsSync(join(home, '.agentquad'))).toBe(false)
    expect(existsSync(oldDir)).toBe(true)
    expect(stderrBuf).toMatch(/running quadtodo service/i)
  })

  it('does no migration when no legacy dir exists', async () => {
    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })
    expect(result.action).toBe('skip')
    expect(result.reason).toBe('no-legacy')
  })

  it('rewrites ~/.claude/settings.json command paths for managed entries', async () => {
    const oldDir = join(home, '.quadtodo')
    const newDir = join(home, '.agentquad')
    const claudeDir = join(home, '.claude')
    mkdirSync(oldDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'x')
    const settingsPath = join(claudeDir, 'settings.json')
    const oldHookCmd = `node ${join(oldDir, 'claude-hooks', 'notify.js')} stop`
    const oldMcpCmd = `node ${join(oldDir, 'src', 'mcp', 'server.js')}`
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: {
        agentquad: { type: 'stdio', command: oldMcpCmd },
        other: { type: 'stdio', command: '/usr/bin/other-mcp' },
      },
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: oldHookCmd, _quadtodoManaged: true },
              { type: 'command', command: oldHookCmd, _quadtodoManaged: false },
            ],
          },
        ],
      },
    }, null, 2))

    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })

    expect(result.action).toBe('migrated')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // managed entry was rewritten
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      `node ${join(newDir, 'claude-hooks', 'notify.js')} stop`
    )
    // unmanaged entry was NOT rewritten
    expect(settings.hooks.Stop[0].hooks[1].command).toBe(oldHookCmd)
    // mcp entry whose command contains oldDir was rewritten (no marker gating on MCP)
    expect(settings.mcpServers.agentquad.command).toBe(
      `node ${join(newDir, 'src', 'mcp', 'server.js')}`
    )
    // third-party MCP entry left alone
    expect(settings.mcpServers.other.command).toBe('/usr/bin/other-mcp')
  })

  it('does not rewrite sibling-prefix paths in config.json', async () => {
    const oldDir = join(home, '.quadtodo')
    const newDir = join(home, '.agentquad')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'x')
    writeFileSync(join(oldDir, 'config.json'), JSON.stringify({
      backupRef: join(home, '.quadtodo-backup', 'foo'),  // sibling, must be preserved
      wiki: { wikiDir: join(oldDir, 'wiki') },           // canonical, must be migrated
    }))

    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })

    expect(result.action).toBe('migrated')
    const cfg = JSON.parse(readFileSync(join(newDir, 'config.json'), 'utf8'))
    expect(cfg.wiki.wikiDir).toBe(join(newDir, 'wiki'))
    expect(cfg.backupRef).toBe(join(home, '.quadtodo-backup', 'foo'))  // unchanged
  })
})

describe('auto-run at config.js import', () => {
  let home

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentquad-autorun-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('migrates legacy dir when src/config.js is imported as the entry point', () => {
    const oldDir = join(home, '.quadtodo')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'sentinel')

    // Spawn a child node process where HOME=tmp dir, no skip vars set,
    // and a tiny script imports src/config.js for its side effect.
    const cleanEnv = { ...process.env, HOME: home }
    delete cleanEnv.AGENTQUAD_SKIP_AUTO_MIGRATE
    delete cleanEnv.AGENTQUAD_ROOT_DIR
    delete cleanEnv.QUADTODO_ROOT_DIR
    delete cleanEnv.VITEST
    cleanEnv.NODE_ENV = 'production'

    const result = spawnSync(
      process.execPath,
      ['-e', "import('./src/config.js').then(()=>{}).catch(e=>{console.error(e);process.exit(2)})"],
      {
        cwd: process.cwd(),
        env: cleanEnv,
        encoding: 'utf8',
      }
    )

    expect(result.status).toBe(0)
    expect(existsSync(join(home, '.agentquad', 'data.db'))).toBe(true)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(home, '.agentquad', '.migrated-from-quadtodo'))).toBe(true)
    // The migration message goes to stderr of the child:
    expect(result.stderr).toMatch(/migrated/i)
  })

  it('does NOT migrate when VITEST=true (the test environment)', () => {
    const oldDir = join(home, '.quadtodo')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'sentinel')

    const result = spawnSync(
      process.execPath,
      ['-e', "import('./src/config.js').then(()=>{}).catch(e=>{console.error(e);process.exit(2)})"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          VITEST: 'true',
        },
        encoding: 'utf8',
      }
    )

    expect(result.status).toBe(0)
    // Legacy dir untouched — no migration ran.
    expect(existsSync(oldDir)).toBe(true)
    expect(existsSync(join(oldDir, 'data.db'))).toBe(true)
    // No migration marker, and the legacy data.db was NOT copied across.
    // (Note: canUseRootDir still has a mkdirSync side effect that creates an
    // empty ~/.agentquad/ — that's the pre-existing surgery-for-another-time
    // issue. We just verify migration logic didn't fire.)
    expect(existsSync(join(home, '.agentquad', '.migrated-from-quadtodo'))).toBe(false)
    expect(existsSync(join(home, '.agentquad', 'data.db'))).toBe(false)
  })
})
