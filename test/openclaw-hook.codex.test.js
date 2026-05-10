import { describe, it, expect, vi } from 'vitest'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'

function fakeBridge() {
  return {
    postText: vi.fn(async () => ({ ok: true })),
    postCard: vi.fn(async () => ({ ok: true })),
    sendDocument: vi.fn(async () => ({ ok: true })),
  }
}

describe('openclaw-hook codex branch', () => {
  it('routes source=codex,path=jsonl Stop to bridge.postText with codex transcript', async () => {
    const bridge = fakeBridge()
    const aiTerminal = { sessions: new Map() }
    const sidecar = { lookup: () => ({ quadtodoSessionId: 'qs1', todoId: 't1', cwd: '/x' }) }
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: () => null },
      aiTerminal,
      sidecar,
      pty: { findCodexSession: () => ({ filePath: 'fake.jsonl', cwd: '/x', nativeId: 'n1' }) },
      readLatestCodexTurnFresh: vi.fn(async () => ({ text: 'codex says hi', raw: {}, timestamp: null })),
      buildFullCodexTranscript: () => ({ markdown: '# header\n\nhi' }),
      extractCodexTurnUsageFromLines: () => ({ input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }),
      extractSessionUsageFromLines: () => ({ input: 1000, output: 500, primaryModel: 'gpt-5-codex', turnCount: 3 }),
      readJsonlLines: () => [],
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n1', transcript_path: 'fake.jsonl',
    })
    expect(result.ok).toBe(true)
    expect(bridge.postText).toHaveBeenCalled()
    const sentArg = bridge.postText.mock.calls[0][0]
    expect(sentArg.text).toContain('codex says hi')
  })

  it('handler returns error when nativeId not in sidecar nor sessions', async () => {
    const bridge = fakeBridge()
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: () => null },
      aiTerminal: { sessions: new Map() },
      sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({ source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'unknown' })
    expect(result.ok).toBe(false)
    expect(bridge.postText).not.toHaveBeenCalled()
  })

  it('routes source=codex,path=detector Notification to bridge.postCard with Codex header', async () => {
    const bridge = fakeBridge()
    const aiTerminal = { sessions: new Map([['qs1', { todoId: 't1' }]]) }
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: {
        listPendingQuestions: () => [],
        getTodo: async () => ({ id: 't1', title: '清理仓库' }),
      },
      aiTerminal,
      sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex',
      path: 'detector',
      event: 'Notification',
      sessionId: 'qs1',
      promptText: 'Approve? (y/n)',
    })
    expect(result.ok).toBe(true)
    expect(bridge.postCard).toHaveBeenCalled()
    const arg = bridge.postCard.mock.calls[0][0]
    expect(arg.sessionId).toBe('qs1')
    const cardJson = JSON.stringify(arg.card)
    expect(cardJson).toContain('Codex 等待授权')
    expect(cardJson).not.toContain('Claude Code 等待授权')
    expect(cardJson).toContain('Approve? (y/n)')
  })

  it('returns session_gone when sessionId not in aiTerminal.sessions', async () => {
    const bridge = fakeBridge()
    const handler = createOpenClawHookHandler({
      bridge,
      openclaw: bridge,
      db: { listPendingQuestions: () => [], getTodo: async () => null },
      aiTerminal: { sessions: new Map() },
      sidecar: { lookup: () => null },
      pty: { findCodexSession: () => null },
      logger: { warn: () => {}, info: () => {} },
    })
    const result = await handler.handle({
      source: 'codex',
      path: 'detector',
      event: 'Notification',
      sessionId: 'gone',
      promptText: 'Approve? (y/n)',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('session_gone')
    expect(bridge.postCard).not.toHaveBeenCalled()
  })
})
