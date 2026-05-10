import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexSidecar } from '../src/codex-sidecar.js'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-sidecar-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('codex-sidecar', () => {
  it('write() updates memory map synchronously and fsyncs file', async () => {
    const sc = createCodexSidecar({ baseDir: dir })
    await sc.write({ nativeId: 'abc', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' })
    expect(sc.lookup('abc')).toEqual({ quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' })
    const file = JSON.parse(readFileSync(join(dir, 'abc.json'), 'utf8'))
    expect(file).toMatchObject({ nativeId: 'abc', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' })
  })

  it('lookup() returns null for unknown id', () => {
    const sc = createCodexSidecar({ baseDir: dir })
    expect(sc.lookup('missing')).toBeNull()
  })

  it('restoreFromDisk() rebuilds memory map from sidecar files', async () => {
    const sc1 = createCodexSidecar({ baseDir: dir })
    await sc1.write({ nativeId: 'a', quadtodoSessionId: 'q1', todoId: 't1', cwd: '/x' })
    await sc1.write({ nativeId: 'b', quadtodoSessionId: 'q2', todoId: 't2', cwd: '/y' })
    const sc2 = createCodexSidecar({ baseDir: dir })
    sc2.restoreFromDisk()
    expect(sc2.lookup('a')).toMatchObject({ quadtodoSessionId: 'q1' })
    expect(sc2.lookup('b')).toMatchObject({ quadtodoSessionId: 'q2' })
  })

  it('clear(nativeId) removes from memory and disk', async () => {
    const sc = createCodexSidecar({ baseDir: dir })
    await sc.write({ nativeId: 'x', quadtodoSessionId: 'q', todoId: 't', cwd: '/z' })
    sc.clear('x')
    expect(sc.lookup('x')).toBeNull()
  })
})
