import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHooks,
  uninstallHooks,
  inspectHooks,
  deployHookScript,
  bootstrapCursorHooks,
  __test__,
} from '../src/cursor-hook-installer.js'

describe('cursor-hook-installer', () => {
  let dir, hooksPath, scriptPath, templatePath, markerPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-cursor-hook-'))
    hooksPath = join(dir, 'hooks.json')
    scriptPath = join(dir, 'notify.js')
    templatePath = join(dir, 'template-notify.js')
    markerPath = join(dir, '.uninstalled')
    writeFileSync(templatePath, '#!/usr/bin/env node\n// quadtodo-hook-version: 3\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('installHooks', () => {
    beforeEach(() => { writeFileSync(scriptPath, '// notify') })

    it('creates fresh hooks.json with version:1 + 3 events', () => {
      const r = installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      expect(r.added.sort()).toEqual(['beforeSubmitPrompt', 'sessionEnd', 'stop'])
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(data.version).toBe(1)
      expect(data.hooks.stop[0].command).toMatch(/notify\.js stop$/)
      expect(data.hooks.beforeSubmitPrompt[0].command).toMatch(/notify\.js notification$/)
      expect(data.hooks.sessionEnd[0].command).toMatch(/notify\.js session-end$/)
      expect(data.hooks.stop[0]._agentquadManaged).toBe(true)
    })

    it('preserves user-defined hooks', () => {
      writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { stop: [{ type: 'command', command: 'echo user' }] } }))
      installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(data.hooks.stop).toHaveLength(2)
      expect(data.hooks.stop.find(e => e.command === 'echo user')).toBeTruthy()
      expect(data.hooks.stop.find(e => e._agentquadManaged)).toBeTruthy()
    })

    it('idempotent reinstall', () => {
      installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      for (const e of ['stop', 'beforeSubmitPrompt', 'sessionEnd']) {
        expect(data.hooks[e].filter(x => x._agentquadManaged)).toHaveLength(1)
      }
    })

    it('clears uninstall marker on install', () => {
      writeFileSync(markerPath, 'old')
      installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath, clearUninstallMarker: true })
      expect(existsSync(markerPath)).toBe(false)
    })

    it('throws when script missing', () => {
      expect(() => installHooks({ hooksPath, hookScriptPath: join(dir, 'missing.js'), uninstallMarkerPath: markerPath }))
        .toThrow(/hook script not found/)
    })
  })

  describe('uninstallHooks', () => {
    beforeEach(() => {
      writeFileSync(scriptPath, '// notify')
      installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
    })

    it('removes only _agentquadManaged entries', () => {
      const data = JSON.parse(readFileSync(hooksPath, 'utf8'))
      data.hooks.stop.push({ type: 'command', command: 'echo user' })
      writeFileSync(hooksPath, JSON.stringify(data))
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      const after = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(after.hooks.stop).toHaveLength(1)
      expect(after.hooks.stop[0]._agentquadManaged).toBeFalsy()
    })

    it('writes marker by default', () => {
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      expect(existsSync(markerPath)).toBe(true)
    })

    it('clean empty hooks object', () => {
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      const after = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(after.hooks).toBeUndefined()
    })

    it('preserves version field', () => {
      uninstallHooks({ hooksPath, uninstallMarkerPath: markerPath })
      const after = JSON.parse(readFileSync(hooksPath, 'utf8'))
      expect(after.version).toBe(1)
    })
  })

  describe('inspectHooks', () => {
    it('installed=false on empty', () => {
      writeFileSync(scriptPath, '// notify')
      const r = inspectHooks({ hooksPath, hookScriptPath: scriptPath })
      expect(r.installed).toBe(false)
    })

    it('installed=true after install', () => {
      writeFileSync(scriptPath, '// notify')
      installHooks({ hooksPath, hookScriptPath: scriptPath, uninstallMarkerPath: markerPath })
      const r = inspectHooks({ hooksPath, hookScriptPath: scriptPath })
      expect(r.installed).toBe(true)
      expect(r.eventsInstalled.sort()).toEqual(['beforeSubmitPrompt', 'sessionEnd', 'stop'])
    })

    it('error code on malformed json', () => {
      writeFileSync(scriptPath, '// notify')
      writeFileSync(hooksPath, '{not json')
      const r = inspectHooks({ hooksPath, hookScriptPath: scriptPath })
      expect(r.error).toBe('malformed_hooks_json')
    })
  })

  describe('eventToArg', () => {
    it('maps cursor event names to argv shorthand', () => {
      expect(__test__.eventToArg('stop')).toBe('stop')
      expect(__test__.eventToArg('beforeSubmitPrompt')).toBe('notification')
      expect(__test__.eventToArg('sessionEnd')).toBe('session-end')
    })
  })

  describe('bootstrapCursorHooks', () => {
    it('happy path full deploy', () => {
      const r = bootstrapCursorHooks({ hooksPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r.skipped).toBe(false)
      expect(r.alreadyInstalled).toBe(false)
      expect(r.scriptResult.action).toBe('installed')
      expect(r.hookResult.added.sort()).toEqual(['beforeSubmitPrompt', 'sessionEnd', 'stop'])
    })

    it('respects uninstall marker', () => {
      writeFileSync(markerPath, 'x')
      const r = bootstrapCursorHooks({ hooksPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r.skipped).toBe(true)
      expect(r.reason).toBe('uninstall_marker')
    })

    it('alreadyInstalled=true second run', () => {
      bootstrapCursorHooks({ hooksPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      const r2 = bootstrapCursorHooks({ hooksPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r2.alreadyInstalled).toBe(true)
    })

    it('warn-skips on malformed hooks.json', () => {
      writeFileSync(hooksPath, '{not json')
      const r = bootstrapCursorHooks({ hooksPath, scriptPath, templatePath, uninstallMarkerPath: markerPath })
      expect(r.skipped).toBe(true)
      expect(r.reason).toBe('malformed_hooks_json')
    })
  })
})
