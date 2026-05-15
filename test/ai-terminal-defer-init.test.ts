// @vitest-environment jsdom
/**
 * Defer-init 时序集成测试
 *
 * 直接对 module-level 辅助函数（proposeColsFromAncestor / measureCharWidth）做断言，
 * 完整组件挂载在 jsdom 下 xterm.js canvas 渲染不稳，不在本测试覆盖（手测验收）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { proposeColsFromAncestor } from '../web/src/AiTerminalMini.tsx'

describe('AiTerminalMini defer-init timing — helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('proposeColsFromAncestor returns valid cols when container is hidden but ancestor is visible', () => {
    const session = document.createElement('div')
    Object.defineProperty(session, 'offsetParent', { value: document.body })
    Object.defineProperty(session, 'clientWidth', { value: 1600 })
    Object.defineProperty(session, 'clientHeight', { value: 900 })
    const hiddenLive = document.createElement('div')
    Object.defineProperty(hiddenLive, 'offsetParent', { value: null })  // display:none
    Object.defineProperty(hiddenLive, 'clientWidth', { value: 0 })
    session.appendChild(hiddenLive)
    document.body.appendChild(session)

    const result = proposeColsFromAncestor(hiddenLive, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)  // MIN_VALID_COLS
    expect(result!.cols).toBeLessThanOrEqual(220)    // 1600 / 7.8 ≈ 205，留 buffer
    expect(result!.rows).toBeGreaterThan(10)
  })

  it('proposeColsFromAncestor uses MIN_VALID_COLS lower bound on narrow viewport', () => {
    const session = document.createElement('div')
    Object.defineProperty(session, 'offsetParent', { value: document.body })
    Object.defineProperty(session, 'clientWidth', { value: 320 })
    Object.defineProperty(session, 'clientHeight', { value: 700 })
    document.body.appendChild(session)

    const result = proposeColsFromAncestor(session, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)  // 钳到下限
  })
})
