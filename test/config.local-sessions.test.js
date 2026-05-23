import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

describe('localSessions config', () => {
  let rootDir
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'aq-cfg-'))
  })
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('loadConfig 默认应包含 localSessions 子树', async () => {
    const cfg = await loadConfig({ rootDir })
    expect(cfg.localSessions).toBeDefined()
    expect(cfg.localSessions.autoCapture.enabled).toBe(true)
    expect(cfg.localSessions.autoCapture.redactCwd).toBe('basename')
    expect(cfg.localSessions.defaultTelegramRoute).toBeNull()
    expect(cfg.localSessions.defaultLarkRoute).toBeNull()
    expect(cfg.localSessions.skipEnvVar).toBe('AGENTQUAD_SKIP_CAPTURE')
  })
})
