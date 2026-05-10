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
})
