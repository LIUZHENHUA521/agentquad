// Pure helpers: given already-read JSONL lines + tool, return usage summary.
// No I/O. No throw on bad lines; returns parseErrorCount instead.

const MODEL_DATE_SUFFIX = /-\d{8}$/ // e.g. "-20260101"

function normalizeModel(name) {
  if (!name) return null
  return String(name).replace(MODEL_DATE_SUFFIX, '')
}

function pickMode(counter) {
  let best = null, bestN = -1
  for (const [k, n] of counter) if (n > bestN) { best = k; bestN = n }
  return best
}

// Shared accumulation: takes normalized records { usage, model, ts } and returns summary.
function accumulateRecords(records, idleThresholdMs) {
  let input = 0, output = 0, cacheR = 0, cacheC = 0
  const modelCounter = new Map()
  const assistantTs = []
  for (const { usage: u = {}, model, ts } of records) {
    input  += Number(u.input_tokens)  || 0
    output += Number(u.output_tokens) || 0
    cacheR += Number(u.cache_read_input_tokens)     || 0
    cacheC += Number(u.cache_creation_input_tokens) || 0
    if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    if (!Number.isNaN(ts)) assistantTs.push(ts)
  }
  let activeMs = 0
  assistantTs.sort((a, b) => a - b)
  for (let i = 1; i < assistantTs.length; i++) {
    const dt = assistantTs[i] - assistantTs[i - 1]
    if (dt > 0 && dt <= idleThresholdMs) activeMs += dt
  }
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheR, cacheCreationTokens: cacheC,
    primaryModel: pickMode(modelCounter),
    activeMs,
  }
}

function extractClaude(lines, { idleThresholdMs }) {
  const records = []
  let errors = 0
  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }
    const msg = j.message
    if (msg?.role !== 'assistant') continue
    records.push({
      usage: msg.usage || {},
      model: normalizeModel(msg.model),
      ts: j.timestamp ? Date.parse(j.timestamp) : NaN,
    })
  }
  return { ...accumulateRecords(records, idleThresholdMs), parseErrorCount: errors }
}

function extractCodex(lines, { idleThresholdMs }) {
  let lastTokenCountInfo = null
  const responseItemRecords = []
  const modelCounter = new Map()
  const assistantTs = []
  let errors = 0

  for (const line of lines) {
    if (!line || !line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { errors++; continue }

    if (j.type === 'event_msg' && j.payload?.type === 'token_count') {
      const info = j.payload?.info
      if (info?.total_token_usage) lastTokenCountInfo = info
    } else if (j.type === 'response_item' && j.payload?.type === 'message' && j.payload?.role === 'assistant') {
      const model = normalizeModel(j.payload.model)
      if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
      const ts = j.timestamp ? Date.parse(j.timestamp) : NaN
      if (!Number.isNaN(ts)) assistantTs.push(ts)
      const u = j.payload.token_usage || j.payload.usage
      if (u) responseItemRecords.push({ usage: u, model, ts })
    } else if (j.type === 'session_meta') {
      const model = normalizeModel(j.payload?.model || j.payload?.model_provider?.model)
      if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    } else if (j.type === 'turn_context') {
      const model = normalizeModel(j.payload?.model || j.payload?.collaboration_mode?.settings?.model)
      if (model) modelCounter.set(model, (modelCounter.get(model) || 0) + 1)
    }
  }

  let input = 0, output = 0, cacheR = 0, cacheC = 0
  if (lastTokenCountInfo?.total_token_usage) {
    const t = lastTokenCountInfo.total_token_usage
    input  = Number(t.input_tokens)  || 0
    output = Number(t.output_tokens) || 0
    cacheR = Number(t.cached_input_tokens || t.cache_read_input_tokens) || 0
    cacheC = Number(t.cache_creation_input_tokens) || 0
  } else {
    for (const r of responseItemRecords) {
      input  += Number(r.usage.input_tokens)  || 0
      output += Number(r.usage.output_tokens) || 0
      cacheR += Number(r.usage.cached_input_tokens || r.usage.cache_read_input_tokens) || 0
      cacheC += Number(r.usage.cache_creation_input_tokens) || 0
    }
  }

  let activeMs = 0
  assistantTs.sort((a, b) => a - b)
  for (let i = 1; i < assistantTs.length; i++) {
    const dt = assistantTs[i] - assistantTs[i - 1]
    if (dt > 0 && dt <= idleThresholdMs) activeMs += dt
  }

  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: cacheR, cacheCreationTokens: cacheC,
    primaryModel: pickMode(modelCounter),
    activeMs,
    parseErrorCount: errors,
  }
}

export function extractUsage(tool, lines, opts = {}) {
  const o = { idleThresholdMs: 120_000, ...opts }
  if (tool === 'claude') return extractClaude(lines, o)
  if (tool === 'codex')  return extractCodex(lines, o)
  // cursor-agent jsonl 目前不带 token usage 字段（v0.x），返回空 usage 让上游不抛错
  if (tool === 'cursor') return { records: [], totals: {}, parseErrorCount: 0 }
  throw new Error(`unknown tool: ${tool}`)
}
