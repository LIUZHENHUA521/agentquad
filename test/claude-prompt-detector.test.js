import { describe, it, expect, vi } from 'vitest'
import { createClaudePromptDetector } from '../src/claude-prompt-detector.js'

function fakePty() {
  const handlers = []
  return {
    onData(cb) { handlers.push(cb) },
    push(s) { handlers.forEach(h => h(s)) },
  }
}

// 真实 Claude Code 权限框（已 strip ANSI / box drawing 后的近似形态）
// 末尾必须带 "Esc to cancel · Tab to amend"：detector 用这个 footer 把真权限框
// 跟 AI 自由回复里的"Do you want... 1. ... 2. ..."类列表区分开。
const REAL_BASH_PROMPT = `
Bash command

  touch /tmp/claude_test_authorization.txt && ls -la /tmp/claude_test_authorization.txt
  Create test file to trigger permission prompt

Do you want to proceed?
1. Yes
2. Yes, and always allow access to tmp/ from this project
3. No

Esc to cancel · Tab to amend
`.trim()

// AI 自由回复里的"看起来像权限框"的内容 —— 有 anchor + 数字选项，但没有 Claude
// TUI footer。detector 必须**拒绝**触发，否则 UI 会把每条 AI 回复都误标待确认。
const AI_REPLY_LOOKS_LIKE_PROMPT = `
Claude:
我可以给你三种思路供选择。

Do you want to try one?
1. 方案 A —— 改动小、风险低
2. 方案 B —— 重构核心、收益大
3. 方案 C —— 渐进式迁移

告诉我选哪个就行。
`.trim()

describe('claude-prompt-detector', () => {
  it('matches the Bash permission box after debounce', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push(REAL_BASH_PROMPT)
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(1)
    const arg = onMatch.mock.calls[0][0]
    expect(arg.promptText).toContain('Do you want to proceed')
    expect(arg.options.length).toBeGreaterThanOrEqual(2)
  })

  it('does NOT match a plain assistant sentence containing the anchor', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    // Claude 回复里描述权限提示但没有 1./2./3. 编号 → 不应触发
    pty.push('I would then ask: Do you want to proceed? It depends on your config.')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).not.toHaveBeenCalled()
  })

  // 用户实测回归：AI 自由回复里有 "Do you want to..." + 数字列表 → 不应触发"待确认"
  it('does NOT match an AI reply that mimics a permission prompt (no Claude TUI footer)', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push(AI_REPLY_LOOKS_LIKE_PROMPT)
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).not.toHaveBeenCalled()
  })

  it('matches when "Tab to select" (slash command picker variant) is present', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push('Do you want to proceed?\n1. Yes\n2. No\n\nEnter to select · Tab to select · Esc to cancel')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(1)
  })

  it('does not re-emit the same prompt text twice', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push(REAL_BASH_PROMPT)
    await new Promise(r => setTimeout(r, 60))
    // TUI redraw 再来一遍同样内容
    pty.push(REAL_BASH_PROMPT)
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(1)
  })

  it('re-emits after reset() (simulating a new turn)', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push(REAL_BASH_PROMPT)
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(1)
    det.reset()
    pty.push(REAL_BASH_PROMPT)
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(2)
  })

  it('does not fire while chunks are still arriving within debounce window', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 30 })
    det.start()
    pty.push('Do you want to proceed?\n1. Yes')
    await new Promise(r => setTimeout(r, 10))
    pty.push('\n2. No')
    await new Promise(r => setTimeout(r, 10))
    pty.push('\nEsc to cancel · Tab to amend')   // 又有 chunk → debounce 重置，footer 才齐
    await new Promise(r => setTimeout(r, 60))
    // 最终窗内 anchor + 选项 + footer 三齐，emit 一次
    expect(onMatch).toHaveBeenCalledTimes(1)
  })

  it('stop() halts further emissions', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createClaudePromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push(REAL_BASH_PROMPT)
    det.stop()
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).not.toHaveBeenCalled()
  })
})
