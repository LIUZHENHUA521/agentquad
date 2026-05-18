import { describe, expect, it, beforeEach } from 'vitest'
import { useAiSessionStore } from '../web/src/store/aiSessionStore.ts'

describe('aiSessionStore turn done updates', () => {
  beforeEach(() => {
    useAiSessionStore.getState().reset()
  })

  it('marks a live session idle and records lastTurnDoneAt immediately', () => {
    useAiSessionStore.getState().setSessions([
      {
        sessionId: 's1',
        todoId: 't1',
        todoTitle: 'T',
        quadrant: 1,
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: 'n1',
        cwd: null,
        startedAt: 1000,
        completedAt: null,
        lastOutputAt: 2000,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        awaitingReply: false,
      },
    ])

    useAiSessionStore.getState().markSessionTurnDone('s1', 'idle', 3000)

    const session = useAiSessionStore.getState().sessions.get('s1')
    expect(session?.status).toBe('idle')
    expect(session?.lastTurnDoneAt).toBe(3000)
    expect(session?.awaitingReply).toBe(true)
  })

  it('markSessionAwaitingReply flips awaitingReply without touching status or lastTurnDoneAt', () => {
    useAiSessionStore.getState().setSessions([
      {
        sessionId: 's1',
        todoId: 't1',
        todoTitle: 'T',
        quadrant: 1,
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: 'n1',
        cwd: null,
        startedAt: 1000,
        completedAt: null,
        lastOutputAt: 2000,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        awaitingReply: false,
      },
    ])

    useAiSessionStore.getState().markSessionAwaitingReply('s1', true)

    const session = useAiSessionStore.getState().sessions.get('s1')
    expect(session?.awaitingReply).toBe(true)
    // 不应触及 status / lastTurnDoneAt —— 后续服务端真正的 turn_done 才更新它们
    expect(session?.status).toBe('running')
    expect(session?.lastTurnDoneAt).toBeNull()
  })

  it('markSessionAwaitingReply is a no-op when value already matches', () => {
    useAiSessionStore.getState().setSessions([
      {
        sessionId: 's1',
        todoId: 't1',
        todoTitle: 'T',
        quadrant: 1,
        tool: 'claude',
        status: 'running',
        autoMode: null,
        nativeSessionId: 'n1',
        cwd: null,
        startedAt: 1000,
        completedAt: null,
        lastOutputAt: 2000,
        lastTurnDoneAt: null,
        outputBytesTotal: 0,
        awaitingReply: true,
      },
    ])

    const before = useAiSessionStore.getState().sessions
    useAiSessionStore.getState().markSessionAwaitingReply('s1', true)
    // 引用相等：值没变就不重建 Map，避免无意义的 React re-render
    expect(useAiSessionStore.getState().sessions).toBe(before)
  })

  it('markSessionAwaitingReply ignores unknown sessionId', () => {
    const before = useAiSessionStore.getState().sessions
    useAiSessionStore.getState().markSessionAwaitingReply('missing', true)
    expect(useAiSessionStore.getState().sessions).toBe(before)
  })
})

describe('aiSessionStore setSessions terminal monotonicity', () => {
  beforeEach(() => {
    useAiSessionStore.getState().reset()
  })

  const base = {
    sessionId: 's1',
    todoId: 't1',
    todoTitle: 'T',
    quadrant: 1 as const,
    tool: 'claude' as const,
    autoMode: null,
    nativeSessionId: 'n1',
    cwd: null,
    startedAt: 1000,
    completedAt: null,
    lastOutputAt: 2000,
    lastTurnDoneAt: null,
    outputBytesTotal: 0,
    awaitingReply: false,
  }

  it('keeps local stopped status when server still reports running (kill-in-flight window)', () => {
    // 模拟：用户点 Cancel 后乐观把 status 翻 stopped
    useAiSessionStore.getState().setSessions([{ ...base, status: 'running' }])
    useAiSessionStore.getState().updateSessionStatus('s1', 'stopped', 9000)

    // 3s 轮询时 server 还没追上，还报 running
    useAiSessionStore.getState().setSessions([{ ...base, status: 'running' }])

    const s = useAiSessionStore.getState().sessions.get('s1')
    expect(s?.status).toBe('stopped')        // 不能被回写成 running
    expect(s?.completedAt).toBe(9000)        // 终态的 completedAt 也保留
  })

  it('keeps local done/failed status when server lags behind', () => {
    useAiSessionStore.getState().setSessions([{ ...base, status: 'pending_confirm' }])
    useAiSessionStore.getState().updateSessionStatus('s1', 'done', 9000)
    useAiSessionStore.getState().setSessions([{ ...base, status: 'pending_confirm' }])
    expect(useAiSessionStore.getState().sessions.get('s1')?.status).toBe('done')

    useAiSessionStore.getState().setSessions([{ ...base, status: 'running' }])
    useAiSessionStore.getState().updateSessionStatus('s1', 'failed', 9000)
    useAiSessionStore.getState().setSessions([{ ...base, status: 'running' }])
    expect(useAiSessionStore.getState().sessions.get('s1')?.status).toBe('failed')
  })

  it('accepts terminal->terminal transitions from server (lets server keep the canonical terminal)', () => {
    useAiSessionStore.getState().setSessions([{ ...base, status: 'running' }])
    useAiSessionStore.getState().updateSessionStatus('s1', 'stopped', 9000)
    // server 真正死掉后报 done（比如 PTY 正常退出）
    useAiSessionStore.getState().setSessions([{ ...base, status: 'done', completedAt: 12345 }])
    const s = useAiSessionStore.getState().sessions.get('s1')
    expect(s?.status).toBe('done')           // 终态间允许 server 覆写
    expect(s?.completedAt).toBe(12345)
  })

  it('drops session when it disappears from server list (cleanup at 30min)', () => {
    useAiSessionStore.getState().setSessions([{ ...base, status: 'running' }])
    useAiSessionStore.getState().updateSessionStatus('s1', 'stopped', 9000)
    useAiSessionStore.getState().setSessions([])   // server 已清理
    expect(useAiSessionStore.getState().sessions.has('s1')).toBe(false)
  })
})
