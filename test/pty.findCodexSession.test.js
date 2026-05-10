import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCodexSession } from '../src/pty.js'

let root
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'codex-find-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function writeRollout(dir, nativeId, sessionMeta = null) {
  const file = join(dir, `rollout-2026-05-09T10-00-00-${nativeId}.jsonl`)
  const lines = []
  if (sessionMeta) {
    lines.push(JSON.stringify({
      timestamp: '2026-05-09T10:00:00Z',
      type: 'session_meta',
      payload: { id: nativeId, cwd: sessionMeta.cwd, originator: 'codex-tui' },
    }))
  }
  writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''))
  return file
}

describe('findCodexSession', () => {
  it('returns {filePath, cwd, nativeId} when session_meta present', () => {
    const day = join(root, '2026', '05', '09')
    mkdirSync(day, { recursive: true })
    const id = '019e0d94-1c56-7372-8029-545ded260180'
    const expected = writeRollout(day, id, { cwd: '/Users/me/proj' })
    const result = findCodexSession(id, { sessionsRoot: root })
    expect(result).toEqual({ filePath: expected, cwd: '/Users/me/proj', nativeId: id })
  })

  it('returns cwd:null when session_meta unflushed', () => {
    const day = join(root, '2026', '05', '09')
    mkdirSync(day, { recursive: true })
    const id = '019e0d94-aaaa-bbbb-cccc-545ded260180'
    const expected = writeRollout(day, id, null)
    const result = findCodexSession(id, { sessionsRoot: root })
    expect(result).toEqual({ filePath: expected, cwd: null, nativeId: id })
  })

  it('isolates parallel sessions in same day dir by nativeId', () => {
    const day = join(root, '2026', '05', '09')
    mkdirSync(day, { recursive: true })
    const a = '019e0d94-1111-1111-1111-545ded260180'
    const b = '019e0d94-2222-2222-2222-545ded260180'
    writeRollout(day, a, { cwd: '/A' })
    writeRollout(day, b, { cwd: '/B' })
    expect(findCodexSession(a, { sessionsRoot: root })?.cwd).toBe('/A')
    expect(findCodexSession(b, { sessionsRoot: root })?.cwd).toBe('/B')
  })

  it('returns null when nativeId not found', () => {
    expect(findCodexSession('does-not-exist', { sessionsRoot: root })).toBeNull()
  })
})
