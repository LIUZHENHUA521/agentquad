import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PtyManager } from '../src/pty.js'

describe('PtyManager codex spawn', () => {
  it('writes sidecar + memory map after detecting Codex nativeId', async () => {
    const fakeSidecar = { write: vi.fn(async () => {}), clear: vi.fn() }
    const fakePty = { write: vi.fn(), onData: () => {}, onExit: () => {}, kill: () => {} }
    const ptyFactory = vi.fn(() => fakePty)
    const codexWatcherFactory = (_t, hit) => { setTimeout(() => hit('native-uuid-1'), 10); return { close() {} } }
    const mgr = new PtyManager({
      tools: { codex: { bin: '/usr/bin/codex', args: [] } },
      ptyFactory,
      codexWatcherFactory,
      sidecar: fakeSidecar,
    })
    const sess = await mgr.spawn({ tool: 'codex', sessionId: 'qs1', cwd: '/proj', todoId: 't1' })
    await new Promise(r => setTimeout(r, 30))
    expect(fakeSidecar.write).toHaveBeenCalledWith({
      nativeId: 'native-uuid-1', quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/proj',
    })
    sess.kill()
    expect(fakeSidecar.clear).toHaveBeenCalledWith('native-uuid-1')
  })
})
