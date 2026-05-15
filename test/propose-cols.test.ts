// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'

describe('proposeColsFromAncestor', () => {
  it('uses ancestor clientWidth when container has zero width', async () => {
    const { proposeColsFromAncestor } = await import('../web/src/AiTerminalMini.tsx')
    const ancestor = document.createElement('div')
    Object.defineProperty(ancestor, 'offsetParent', { value: document.body })
    Object.defineProperty(ancestor, 'clientWidth', { value: 1200 })
    Object.defineProperty(ancestor, 'clientHeight', { value: 800 })
    const inner = document.createElement('div')
    Object.defineProperty(inner, 'offsetParent', { value: null })
    Object.defineProperty(inner, 'clientWidth', { value: 0 })
    ancestor.appendChild(inner)
    document.body.appendChild(ancestor)
    const result = proposeColsFromAncestor(inner, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)
    expect(result!.rows).toBeGreaterThan(0)
    ancestor.remove()
  })

  it('clamps cols to MIN_VALID_COLS when ancestor is narrow', async () => {
    const { proposeColsFromAncestor } = await import('../web/src/AiTerminalMini.tsx')
    const ancestor = document.createElement('div')
    Object.defineProperty(ancestor, 'offsetParent', { value: document.body })
    Object.defineProperty(ancestor, 'clientWidth', { value: 320 })
    Object.defineProperty(ancestor, 'clientHeight', { value: 600 })
    document.body.appendChild(ancestor)
    const result = proposeColsFromAncestor(ancestor, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)
    ancestor.remove()
  })

  it('returns null when no ancestor has layout', async () => {
    const { proposeColsFromAncestor } = await import('../web/src/AiTerminalMini.tsx')
    const orphan = document.createElement('div')
    Object.defineProperty(orphan, 'offsetParent', { value: null })
    Object.defineProperty(orphan, 'clientWidth', { value: 0 })
    const result = proposeColsFromAncestor(orphan, 7.8)
    expect(result).toBeNull()
  })
})
