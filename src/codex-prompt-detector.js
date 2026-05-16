/**
 * Codex CLI stdout 提示词检测器：把 Codex 在 PTY 里弹出来的"是否允许运行命令？"
 * 兜底转成 markPendingConfirm + IM 卡片，跟 Claude detector 一对的。
 *
 * 新版 Codex (gpt-5-codex / codex-cli 0.2+) 的 prompt 形态：
 *   Would you like to run the following command?
 *   Reason: ...
 *
 *   $ <command>
 *
 *   1. Yes, proceed (y)
 *   2. Yes, and don't ask again for commands that start with `<cmd>` (p)
 *   3. No, and tell Codex what to do differently (esc)
 *
 * 旧 Codex 的 `[y/N]` / `apply patch?` 单行问句已经被淘汰；老的 PATTERNS 一个都不命中
 * 真权限框，结果是 PTY 卡住但 IM 收不到卡片。
 *
 * 新检测规则（与 claude-prompt-detector 同思路）：
 *   1) anchor: "Would you like to" + "?" 出现在尾部
 *   2) 末尾 5 行内有 `(esc)` 选项（Codex 真权限框第 3 个选项一定是 "...(esc)"）
 *   3) anchor → 末尾之间有 ≥2 个 "N. xxx (y/p/esc/n)" 形式的数字选项
 *
 * 三个信号一起到位才认；AI 自由回复里偶尔出现 "Would you like to" + 数字列表
 * 不会有 `(esc)` 那种 hotkey 后缀，照常不命中。
 *
 * 兼容老 Codex：保留旧的 single-line `[y/N]` / `apply patch?` 形式作为 fallback。
 */
const DEFAULT_DEBOUNCE_MS = 1500
const RING_MAX = 32

// 老 Codex 的单行问句（保留兜底，1.x 老版本还能用）
const LEGACY_SINGLE_LINE_PATTERNS = [
  /(approve|allow|continue|proceed)\??\s*\(\s*y\/n\s*\)\s*$/i,
  /\?\s*\[\s*y\/N\s*\]\s*$/i,
  /\?\s*\[\s*Y\/n\s*\]\s*$/i,
  /(允许|批准|授权).*\?\s*[（(]\s*[yYnN][\/／][nNyY][)）]\s*$/,
  /run this command\?\s*\[[^\]]*\]\s*$/i,
  /apply patch\?\s*\[[^\]]*\]\s*$/i,
]

// 新版 Codex 多行权限框的三个识别信号
const CODEX_NEW_ANCHOR = /Would\s+you\s+like\s+to\s+(?:run|apply|approve|continue)/i
const CODEX_NEW_OPTION = /^\s*([1-9])\.\s+(\S.{0,120}?)\s+\(\s*(y|p|n|esc|N|Y)\s*\)\s*$/i
const CODEX_NEW_ESC_OPTION = /\(\s*esc\s*\)\s*$/i

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

/**
 * 新版 Codex prompt 严格匹配。
 * - 末尾 5 行里有 `(esc)` 结尾的选项行
 * - 它上面 15 行内有 anchor ("Would you like to ...")
 * - anchor → esc-option 之间 ≥2 个带 hotkey 后缀的数字选项
 */
function matchCodexNewPrompt(cleaned) {
  const lines = cleaned.split('\n')
  let escIdx = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    if (CODEX_NEW_ESC_OPTION.test(lines[i])) { escIdx = i; break }
  }
  if (escIdx < 0) return null
  const start = Math.max(0, escIdx - 15)
  let anchorIdx = -1
  for (let i = escIdx - 1; i >= start; i--) {
    if (CODEX_NEW_ANCHOR.test(lines[i])) { anchorIdx = i; break }
  }
  if (anchorIdx < 0) return null
  // 收集 anchor → esc 之间的数字选项行（用作 dedup signature 的稳定核心）
  const optionLines = []
  for (let i = anchorIdx + 1; i <= escIdx; i++) {
    if (CODEX_NEW_OPTION.test(lines[i])) optionLines.push(lines[i].trim())
  }
  if (optionLines.length < 2) return null
  return {
    startIdx: anchorIdx,
    endIdx: escIdx,
    text: lines.slice(anchorIdx, escIdx + 1).join('\n'),
    // signature：所有选项行（含 hotkey 后缀）拼起来——同一个 prompt 复用同一份
    // 选项；连续 TUI redraw / ring buffer 重复都映射到同一 sig，dedup 稳。
    sig: optionLines.join('|'),
  }
}

export function createCodexPromptDetector({ pty, onMatch, debounceMs = DEFAULT_DEBOUNCE_MS, emitter = null } = {}) {
  if (!pty || !onMatch) throw new Error('pty, onMatch required')
  const ring = []
  let timer = null
  let stopped = false
  let lastEmittedSig = null

  function onData(chunk) {
    if (stopped) return
    ring.push({ ts: Date.now(), text: stripAnsi(String(chunk)) })
    while (ring.length > RING_MAX) ring.shift()
    if (timer) clearTimeout(timer)
    timer = setTimeout(maybeMatch, debounceMs)
  }

  function ifNotSelfQuotedByAi(text) {
    const resolvedEmitter = typeof emitter === 'function' ? emitter() : emitter
    if (!resolvedEmitter?.getLatestAssistantContent) return text
    const ai = resolvedEmitter.getLatestAssistantContent() || ''
    const trimmed = text.slice(-200).trim()
    if (trimmed && (ai.includes(trimmed) || ai.endsWith(trimmed))) return null
    return text
  }

  function maybeMatch() {
    timer = null
    if (stopped) return
    const tail = ring.map(c => c.text).join('')

    // 1) 新版多行权限框优先（gpt-5-codex / codex-cli 0.2+）
    const m = matchCodexNewPrompt(tail)
    if (m) {
      const checked = ifNotSelfQuotedByAi(m.text)
      if (!checked) return
      if (m.sig === lastEmittedSig) return
      lastEmittedSig = m.sig
      onMatch({ promptText: m.text, matchedPattern: 'codex_new_multiline' })
      return
    }

    // 2) 老版单行问句兜底
    let matchedPattern = null
    for (const re of LEGACY_SINGLE_LINE_PATTERNS) {
      if (re.test(tail)) { matchedPattern = re.source; break }
    }
    if (!matchedPattern) return
    const checked = ifNotSelfQuotedByAi(tail)
    if (!checked) return
    const sig = tail.slice(-200)
    if (sig === lastEmittedSig) return
    lastEmittedSig = sig
    onMatch({ promptText: tail.slice(-200), matchedPattern })
  }

  function reset() { lastEmittedSig = null }
  function start() { pty.onData(onData) }
  function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null } }

  return { start, stop, reset }
}
