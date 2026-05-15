// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'

describe('xterm.js v5 — pre-open API behavior', () => {
  it('Terminal.write before open does not throw', () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    expect(() => term.write('hello world\r\n')).not.toThrow()
    term.dispose()
  })

  it('Terminal.dispose before open does not throw', () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    expect(() => term.dispose()).not.toThrow()
  })

  // KNOWN FAILURE in jsdom: xterm's `open()` calls `matchMedia`, which jsdom
  // doesn't implement. We mark this `it.fails` so the suite stays green —
  // the failure documents that we cannot verify pre-open buffer behavior in
  // our test environment, which is exactly why Task 7 uses Path B (pure
  // pendingChunksRef) instead of relying on xterm's pre-open buffer.
  it.fails('writes buffered before open are visible after open', async () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    term.write('foo\r\n')
    const div = document.createElement('div')
    Object.defineProperty(div, 'clientWidth', { value: 800 })
    Object.defineProperty(div, 'clientHeight', { value: 600 })
    document.body.appendChild(div)
    term.open(div)
    // xterm.js 默认 async write —— 用 callback 等 drain
    await new Promise<void>(r => term.write('', () => r()))
    const line = term.buffer.active.getLine(0)
    expect(line?.translateToString(true).startsWith('foo')).toBe(true)
    term.dispose()
    div.remove()
  })
})
