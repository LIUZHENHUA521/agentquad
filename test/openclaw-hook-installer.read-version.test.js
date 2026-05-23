import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInstalledHookVersion, EXPECTED_HOOK_VERSION } from '../src/openclaw-hook-installer.js'

describe('getInstalledHookVersion', () => {
  let dir, settingsPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-rdver-'))
    settingsPath = join(dir, 'settings.json')
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('文件不存在 → null', () => {
    expect(getInstalledHookVersion({ settingsPath: join(dir, 'nope.json') })).toBeNull()
  })

  it('文件不含 managed entry → null', () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'foo' }] }] } }))
    expect(getInstalledHookVersion({ settingsPath })).toBeNull()
  })

  it('单一 managed entry → 返回该版本号', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{
          _quadtodoManaged: true,
          _quadtodoVersion: 'quadtodo-hook-version: 2',
          hooks: [{ command: 'node x.js stop' }]
        }]
      }
    }))
    expect(getInstalledHookVersion({ settingsPath })).toBe(2)
  })

  it('多 managed entry 不同版本 → 返回 min', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{
          _quadtodoManaged: true,
          _quadtodoVersion: 'quadtodo-hook-version: 2',
          hooks: [{ command: 'x' }]
        }],
        SessionStart: [{
          _quadtodoManaged: true,
          _quadtodoVersion: 'quadtodo-hook-version: 1',
          hooks: [{ command: 'y' }]
        }]
      }
    }))
    expect(getInstalledHookVersion({ settingsPath })).toBe(1)
  })

  it('损坏 JSON → regex 兜底', () => {
    writeFileSync(settingsPath, '{ broken json with quadtodo-hook-version: 1 inside')
    expect(getInstalledHookVersion({ settingsPath })).toBe(1)
  })

  it('EXPECTED_HOOK_VERSION 是 number', () => {
    expect(typeof EXPECTED_HOOK_VERSION).toBe('number')
  })
})
