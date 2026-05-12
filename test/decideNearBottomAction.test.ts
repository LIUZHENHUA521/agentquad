// test/decideNearBottomAction.test.ts
import { describe, expect, it } from 'vitest'
import {
  decideNearBottomAction,
  NEAR_BOTTOM_LINES,
} from '../web/src/AiTerminalMini.scrollSnap.ts'

describe('NEAR_BOTTOM_LINES', () => {
  it('exports the agreed threshold of 4 lines', () => {
    expect(NEAR_BOTTOM_LINES).toBe(4)
  })
})

describe('decideNearBottomAction', () => {
  it('已贴底 + 跟随中 → 不做任何事', () => {
    expect(decideNearBottomAction(100, 100, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: null })
  })

  it('已贴底 + 跟随关 → 把跟随置 true', () => {
    expect(decideNearBottomAction(100, 100, false, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: true })
  })

  it('近底 (delta=2) + 跟随中 → 吸附，跟随保持', () => {
    expect(decideNearBottomAction(100, 98, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: true, nextFollowTail: null })
  })

  it('近底 (delta=2) + 跟随关 → 吸附并把跟随置 true', () => {
    expect(decideNearBottomAction(100, 98, false, NEAR_BOTTOM_LINES))
      .toEqual({ snap: true, nextFollowTail: true })
  })

  it('阈值边界 (delta=4) + 跟随中 → 仍吸附', () => {
    expect(decideNearBottomAction(100, 96, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: true, nextFollowTail: null })
  })

  it('越过阈值 (delta=5) + 跟随中 → 不吸附，把跟随置 false', () => {
    expect(decideNearBottomAction(100, 95, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: false })
  })

  it('远离底部 (delta=10) + 跟随关 → 什么都不做', () => {
    expect(decideNearBottomAction(100, 90, false, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: null })
  })

  it('dispY > baseY 的异常值 → 视为已贴底（delta clamp 到 0）', () => {
    expect(decideNearBottomAction(100, 105, true, NEAR_BOTTOM_LINES))
      .toEqual({ snap: false, nextFollowTail: null })
  })

  it('自定义阈值生效：N=1 时 delta=2 不再被吸附', () => {
    expect(decideNearBottomAction(100, 98, true, 1))
      .toEqual({ snap: false, nextFollowTail: false })
  })
})
