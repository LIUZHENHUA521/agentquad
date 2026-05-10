import { describe, it, expect } from 'vitest'
import { parseTrigger } from '../src/session-input-dispatcher.js'

describe('parseTrigger', () => {
  it('普通文本 → queue_or_send', () => {
    expect(parseTrigger('hello')).toEqual({ mode: 'queue_or_send', stripped: 'hello' })
  })

  it('单 ! 前缀 → soft_interrupt，去掉 !', () => {
    expect(parseTrigger('!算了')).toEqual({ mode: 'soft_interrupt', stripped: '算了' })
  })

  it('双 !! 前缀 → hard_cancel', () => {
    expect(parseTrigger('!!stop')).toEqual({ mode: 'hard_cancel', stripped: '' })
  })

  it('精确 /stop → hard_cancel', () => {
    expect(parseTrigger('/stop')).toEqual({ mode: 'hard_cancel', stripped: '' })
  })

  it('/stop 带参数（/stop all）不算 hard_cancel，由 wizard 自己处理 admin 杀 session', () => {
    expect(parseTrigger('/stop all').mode).toBe('queue_or_send')
  })

  it('单 ! 但只有 ! 一个字符 → 视为空 soft_interrupt', () => {
    expect(parseTrigger('!')).toEqual({ mode: 'soft_interrupt', stripped: '' })
  })

  it('前后空白 trim', () => {
    expect(parseTrigger('  !  hi  ')).toEqual({ mode: 'soft_interrupt', stripped: 'hi' })
  })
})
