/**
 * Claude Code stdout 提示词检测器：兜底 Notification hook 不 fire 的场景。
 *
 * 背景：Claude Code 2.x 引入 settings.json `permissions.defaultMode='auto'` 后，
 * 由 model classifier 决定是否要弹权限提示。实测命中这条路径时 Notification hook
 * 不 fire（社区 issue 也复现），导致 AgentQuad 完全收不到信号——状态条仍显示"运行中"，
 * IM 也不会推权限卡片。
 *
 * 实现：与 codex-prompt-detector 同构（环形缓冲区 + 防抖），命中
 * extractPermissionPrompt 的锚点 + 至少 2 个数字选项 + Claude 独有页脚时上报。
 *
 * 误触保护：
 *   - 同一段文本只 emit 一次（lastEmittedText 去重）
 *   - 选项数 < 2 不算 Claude 标准 1/2/3 权限框，跳过（光锚点会被 assistant 自述误触）
 *   - 必须命中 CLAUDE_PERMISSION_FOOTER（"Esc to cancel · Tab to amend" 或同源
 *     "Tab to select"）——AI 自由回复里可能恰好出现"Do you want to" + 数字列表，
 *     但绝不会带这些 TUI 控件提示。这条页脚是把"真权限框"跟"普通 markdown 列表"
 *     区分开的唯一可靠信号
 *   - 调用方（server.js / openclaw-hook 走 cooldown）负责跟真 Notification hook 的去重
 */
import { extractPermissionPrompt } from './permission-prompt.js'

const DEFAULT_DEBOUNCE_MS = 1500
const RING_MAX = 32

// Claude TUI 真权限框/选择器底部固定 footer（cleanPtyTail 不会过滤掉这行）。
// "Esc to cancel"（permission prompt）、"Tab to amend"（permission prompt）、
// "Tab to select"（slash command picker / model picker）。
// AI 自由回复里出现这种字面文本的概率近乎 0。
const CLAUDE_PERMISSION_FOOTER = /Esc\s+to\s+cancel|Tab\s+to\s+amend|Tab\s+to\s+select/i

export function createClaudePromptDetector({ pty, onMatch, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  if (!pty || !onMatch) throw new Error('pty, onMatch required')
  const ring = []
  let timer = null
  let stopped = false
  let lastEmittedText = null

  function onData(chunk) {
    if (stopped) return
    ring.push({ ts: Date.now(), text: String(chunk) })
    while (ring.length > RING_MAX) ring.shift()
    if (timer) clearTimeout(timer)
    timer = setTimeout(maybeMatch, debounceMs)
  }

  function maybeMatch() {
    timer = null
    if (stopped) return
    const tail = ring.map(c => c.text).join('')
    const { text, options } = extractPermissionPrompt(tail)
    if (!text || options.length < 2) return
    // 防 AI 自由回复假阳性：必须带真权限框的 footer，否则不动手
    if (!CLAUDE_PERMISSION_FOOTER.test(text)) return
    // 用尾部 200 字符做去重 key：连续 TUI redraw 会让 extractor 的 window 上下文不一样，
    // 但 prompt 末尾（"Do you want to proceed?\n1. Yes\n..."）总是稳定的——用它判同。
    const sig = text.slice(-200)
    if (sig === lastEmittedText) return
    lastEmittedText = sig
    onMatch({ promptText: text, options })
  }

  // 一轮结束（Stop hook / jsonl turn-done）后调，让下一轮新的 prompt 不被 lastEmittedText 卡掉
  function reset() {
    lastEmittedText = null
  }

  function start() { pty.onData(onData) }
  function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null } }

  return { start, stop, reset, _maybeMatch: maybeMatch, _ring: ring }
}
