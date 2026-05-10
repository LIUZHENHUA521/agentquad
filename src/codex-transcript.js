import { readFileSync } from 'node:fs'

function parseLines(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim())
}

function blockText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(c => c?.text || '').filter(Boolean).join('')
}

export function readLatestCodexTurn(filePath) {
  const lines = parseLines(filePath)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i])
      if (j.type !== 'response_item') continue
      const p = j.payload
      if (p?.type !== 'message' || p?.role !== 'assistant') continue
      const text = blockText(p.content)
      if (!text) continue
      return { text, raw: p, timestamp: j.timestamp || null }
    } catch {}
  }
  return null
}

export async function readLatestCodexTurnFresh(filePath, lastSeenText, { retries = 3, retryMs = 200 } = {}) {
  for (let i = 0; i <= retries; i++) {
    const turn = readLatestCodexTurn(filePath)
    if (turn && turn.text !== lastSeenText) return turn
    if (i < retries) await new Promise(r => setTimeout(r, retryMs))
  }
  return null
}

export function buildFullCodexTranscript(filePath) {
  const lines = parseLines(filePath)
  const out = []
  let turnCount = 0
  for (const line of lines) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.type !== 'response_item' || j.payload?.type !== 'message') continue
    const role = j.payload.role
    const text = blockText(j.payload.content)
    if (!text) continue
    if (role === 'assistant') turnCount++
    out.push(`### ${role}\n\n${text}\n`)
  }
  const header = `# Codex Session Transcript\n\n_Generated: ${new Date().toISOString()}_\n_Source: ${filePath}_\n_Turns: ${turnCount}_\n\n---\n\n`
  return { markdown: header + out.join('\n'), turnCount }
}

export function extractCodexTurnUsageFromLines(lines) {
  let last = null
  for (const line of lines) {
    if (!line || !line.trim()) continue
    try {
      const j = JSON.parse(line)
      if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
        const info = j.payload.info
        if (info?.last_token_usage) last = info.last_token_usage
      }
    } catch {}
  }
  if (!last) return null
  return {
    input: Number(last.input_tokens) || 0,
    output: Number(last.output_tokens) || 0,
    cacheRead: Number(last.cached_input_tokens || last.cache_read_input_tokens) || 0,
    cacheCreation: Number(last.cache_creation_input_tokens) || 0,
  }
}
