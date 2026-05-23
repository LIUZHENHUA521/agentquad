import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as installerMod from '../src/openclaw-hook-installer.js'

const { installHooks, HOOK_EVENTS, EXPECTED_HOOK_VERSION } = installerMod

describe('SessionStart hook install', () => {
  let dir, settingsPath, scriptPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-hook-'))
    settingsPath = join(dir, '.claude.json')
    scriptPath = join(dir, 'notify.js')
    writeFileSync(scriptPath, 'export default 1')
  })

  it('HOOK_EVENTS 包含 SessionStart 以及四个原有事件', () => {
    expect(HOOK_EVENTS).toContain('SessionStart')
    expect(HOOK_EVENTS).toContain('Stop')
    expect(HOOK_EVENTS).toContain('Notification')
    expect(HOOK_EVENTS).toContain('SessionEnd')
    expect(HOOK_EVENTS).toContain('UserPromptSubmit')
  })

  it('EXPECTED_HOOK_VERSION 已被导出且 >= 2', () => {
    expect(typeof EXPECTED_HOOK_VERSION).toBe('number')
    expect(EXPECTED_HOOK_VERSION).toBeGreaterThanOrEqual(2)
  })

  it('install 后 settings.json 含 SessionStart entry', () => {
    installHooks({ settingsPath, hookScriptPath: scriptPath, events: HOOK_EVENTS })
    expect(existsSync(settingsPath)).toBe(true)
    const json = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(json.hooks?.SessionStart).toBeDefined()
    expect(Array.isArray(json.hooks.SessionStart)).toBe(true)
    expect(json.hooks.SessionStart.length).toBeGreaterThan(0)
  })

  it('install 后版本号被注入并 >= EXPECTED_HOOK_VERSION', () => {
    installHooks({ settingsPath, hookScriptPath: scriptPath, events: HOOK_EVENTS })
    const raw = readFileSync(settingsPath, 'utf8')
    const m = raw.match(/quadtodo-hook-version:\s*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBeGreaterThanOrEqual(EXPECTED_HOOK_VERSION)
  })
})
