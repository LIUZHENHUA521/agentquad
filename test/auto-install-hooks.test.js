import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { maybeAutoInstallHooks } from '../src/auto-install-hooks.js'

describe('maybeAutoInstallHooks', () => {
  let homeDir, claudeDir, codexDir

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'aq-aih-'))
    claudeDir = join(homeDir, '.claude')
    codexDir = join(homeDir, '.codex')
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  function withSilentLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('autoInstallHooks=false → 全跳过', () => {
    mkdirSync(claudeDir, { recursive: true })
    mkdirSync(codexDir, { recursive: true })
    const result = maybeAutoInstallHooks({
      config: { localSessions: { autoInstallHooks: false } },
      homeDir,
      logger: withSilentLogger()
    })
    expect(result.claude).toBe('skipped')
    expect(result.codex).toBe('skipped')
    // no settings.json should be written
    expect(existsSync(join(claudeDir, 'settings.json'))).toBe(false)
  })

  it('claude 目录不存在 → claude no-claude-dir', () => {
    // no claude dir created
    const result = maybeAutoInstallHooks({
      config: { localSessions: { autoInstallHooks: true } },
      homeDir,
      logger: withSilentLogger()
    })
    expect(result.claude).toBe('no-claude-dir')
  })

  it('codex 目录不存在 → codex no-codex-dir', () => {
    const result = maybeAutoInstallHooks({
      config: { localSessions: { autoInstallHooks: true } },
      homeDir,
      logger: withSilentLogger()
    })
    expect(result.codex).toBe('no-codex-dir')
  })

  it('config.localSessions 未定义 → 视为已启用（不跳过）', () => {
    // No claude or codex dirs — should get 'no-X-dir', not 'skipped'
    const result = maybeAutoInstallHooks({
      config: {},
      homeDir,
      logger: withSilentLogger()
    })
    expect(result.claude).toBe('no-claude-dir')
    expect(result.codex).toBe('no-codex-dir')
  })

  it('config 完全缺失 → 视为已启用', () => {
    const result = maybeAutoInstallHooks({
      homeDir,
      logger: withSilentLogger()
    })
    expect(result.claude).toBe('no-claude-dir')
    expect(result.codex).toBe('no-codex-dir')
  })

  // We don't smoke-test the actual install side-effects here — those have their
  // own tests in test/openclaw-hook-installer.session-start.test.js and
  // test/codex-hook-installer.test.js. We just verify the dispatch/gating logic.
})
