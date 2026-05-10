import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLatestCodexTurn,
  readLatestCodexTurnFresh,
  buildFullCodexTranscript,
  extractCodexTurnUsageFromLines,
} from '../src/codex-transcript.js'

function makeFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'cx-tr-'))
  const path = join(dir, 'rollout.jsonl')
  writeFileSync(path, lines.map(JSON.stringify).join('\n') + '\n')
  return path
}

describe('codex-transcript', () => {
  it('readLatestCodexTurn returns latest assistant turn text', () => {
    const path = makeFile([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'hi' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] } },
    ])
    const turn = readLatestCodexTurn(path)
    expect(turn?.text).toBe('second')
  })

  it('readLatestCodexTurnFresh retries when latest assistant equals lastSeen', async () => {
    const path = makeFile([
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'old' }] } },
    ])
    const turn = await readLatestCodexTurnFresh(path, 'old', { retries: 2, retryMs: 20 })
    expect(turn).toBeNull()  // never freshened
  })

  it('buildFullCodexTranscript renders user+assistant turns to markdown', () => {
    const path = makeFile([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'q' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'a' }] } },
    ])
    const md = buildFullCodexTranscript(path).markdown
    expect(md).toContain('q')
    expect(md).toContain('a')
  })

  it('extractCodexTurnUsageFromLines reads last_token_usage', () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, output_tokens: 7 } } } }),
    ]
    const r = extractCodexTurnUsageFromLines(lines)
    expect(r).toEqual({ input: 5, output: 7, cacheRead: 0, cacheCreation: 0 })
  })
})
