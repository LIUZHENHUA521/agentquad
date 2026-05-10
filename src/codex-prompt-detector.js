const DEFAULT_DEBOUNCE_MS = 1500
const RING_MAX = 32

const PATTERNS = [
  /(approve|allow|continue|proceed)\??\s*\(\s*y\/n\s*\)\s*$/i,
  /\?\s*\[\s*y\/N\s*\]\s*$/i,
  /\?\s*\[\s*Y\/n\s*\]\s*$/i,
  /(允许|批准|授权).*\?\s*[（(]\s*[yYnN][\/／][nNyY][)）]\s*$/,
  /run this command\?\s*\[[^\]]*\]\s*$/i,
  /apply patch\?\s*\[[^\]]*\]\s*$/i,
]

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

export function createCodexPromptDetector({ pty, onMatch, debounceMs = DEFAULT_DEBOUNCE_MS, emitter = null } = {}) {
  if (!pty || !onMatch) throw new Error('pty, onMatch required')
  const ring = []
  let timer = null
  let stopped = false

  function onData(chunk) {
    if (stopped) return
    ring.push({ ts: Date.now(), text: stripAnsi(String(chunk)) })
    while (ring.length > RING_MAX) ring.shift()
    if (timer) clearTimeout(timer)
    timer = setTimeout(maybeMatch, debounceMs)
  }

  function maybeMatch() {
    const tail = ring.slice(-4).map(c => c.text).join('')
    let matchedPattern = null
    for (const re of PATTERNS) {
      if (re.test(tail)) { matchedPattern = re.source; break }
    }
    if (!matchedPattern) return
    const resolvedEmitter = typeof emitter === 'function' ? emitter() : emitter
    if (resolvedEmitter?.getLatestAssistantContent) {
      const ai = resolvedEmitter.getLatestAssistantContent() || ''
      const trimmed = tail.slice(-200).trim()
      if (trimmed && (ai.includes(trimmed) || ai.endsWith(trimmed))) {
        return  // AI self-quoted prompt; not a real Codex permission ask
      }
    }
    onMatch({ promptText: tail.slice(-200), matchedPattern })
  }

  function start() { pty.onData(onData) }
  function stop() { stopped = true; if (timer) clearTimeout(timer) }

  return { start, stop }
}
