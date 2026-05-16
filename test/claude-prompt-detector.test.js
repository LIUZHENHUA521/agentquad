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
    pty.push('\nMore...')   // 又有 chunk → debounce 重置
    await new Promise(r => setTimeout(r, 60))
    // 最终窗内还是有完整 prompt，会 emit 一次
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
