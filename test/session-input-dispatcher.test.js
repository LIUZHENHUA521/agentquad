import { describe, it, expect, vi } from 'vitest'
import { parseTrigger, createSessionInputDispatcher } from '../src/session-input-dispatcher.js'

function makeDeps({ awaitingReply = true, hasSession = true } = {}) {
  const writes = []
  const pty = {
    write: vi.fn((sid, data) => { writes.push({ sid, data }) }),
    has: vi.fn(() => hasSession),
  }
  const aiTerminal = {
    isSessionAwaitingReply: vi.fn(() => awaitingReply),
  }
  return { pty, aiTerminal, writes }
}

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

describe('send: idle path', () => {
  it('idle + 普通文本 → 直接 pty.write + \\r', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'hello' })
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes).toEqual([
      { sid: 'sid1', data: 'hello' },
      { sid: 'sid1', data: '\r' },
    ])
    vi.useRealTimers()
  })

  it('idle + ! 前缀 → 等同普通投递（去掉 !）', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '!算了' })
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes[0]).toEqual({ sid: 'sid1', data: '算了' })
    vi.useRealTimers()
  })

  it('idle + /stop → noop_idle，不写 PTY', async () => {
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: '/stop' })
    expect(result).toMatchObject({ action: 'noop_idle' })
    expect(writes).toEqual([])
  })

  it('idle + 普通文本 + imagePaths → 拼 @path 前缀', async () => {
    vi.useFakeTimers()
    const { pty, aiTerminal, writes } = makeDeps({ awaitingReply: true })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'caption', imagePaths: ['/tmp/a.png', '/tmp/b.png'] })
    await vi.advanceTimersByTimeAsync(100)
    expect(result).toMatchObject({ action: 'sent' })
    expect(writes[0]).toEqual({ sid: 'sid1', data: '@/tmp/a.png @/tmp/b.png caption' })
    vi.useRealTimers()
  })

  it('PTY 不存在 → session_ended', async () => {
    const { pty, aiTerminal } = makeDeps({ hasSession: false })
    const d = createSessionInputDispatcher({ pty, aiTerminal })
    const result = await d.send({ sessionId: 'sid1', text: 'hello' })
    expect(result).toMatchObject({ action: 'session_ended' })
  })
})
