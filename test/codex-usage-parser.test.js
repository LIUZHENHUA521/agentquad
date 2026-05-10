import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractUsage } from '../src/usage-parser.js'

const fixture = readFileSync(new URL('./fixtures/codex-real-token-count.jsonl', import.meta.url), 'utf8').split('\n')

function groundTruthSession(lines) {
  // Independent computation: pick the LAST event_msg/token_count.payload.info.total_token_usage
  let last = null
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (j.type === 'event_msg' && j.payload?.type === 'token_count' && j.payload?.info?.total_token_usage) {
        last = j.payload.info.total_token_usage
      }
    } catch {}
  }
  return last
}

describe('extractCodex (real fixture)', () => {
  it('extracts non-zero session totals matching ground truth', () => {
    const out = extractUsage('codex', fixture)
    const gt = groundTruthSession(fixture)
    expect(gt).toBeTruthy()
    expect(out.inputTokens).toBe(gt.input_tokens)
    expect(out.outputTokens).toBe(gt.output_tokens)
  })

  it('picks GPT family model from session_meta or response_item', () => {
    const out = extractUsage('codex', fixture)
    expect(out.primaryModel).toMatch(/^gpt-/)
  })

  it('falls back to response_item.token_usage only if no token_count records', () => {
    const synthetic = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', model: 'gpt-5', token_usage: { input_tokens: 10, output_tokens: 20 } } }),
    ]
    const out = extractUsage('codex', synthetic)
    expect(out.inputTokens).toBe(10)
    expect(out.outputTokens).toBe(20)
  })
})
