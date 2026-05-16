import { describe, it, expect, vi } from 'vitest'
import { createCodexPromptDetector } from '../src/codex-prompt-detector.js'

function fakePty() {
  const handlers = []
  return {
    onData(cb) { handlers.push(cb) },
    push(s) { handlers.forEach(h => h(s)) },
  }
}

describe('codex-prompt-detector', () => {
  it('matches "Approve? (y/n)" after debounce', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 30 })
    det.start()
    pty.push('Run command rm -rf /\nApprove? (y/n)')
    await new Promise(r => setTimeout(r, 80))
    expect(onMatch).toHaveBeenCalled()
  })

  it('does NOT match when chunk continues within debounce window', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 30 })
    det.start()
    pty.push('Approve? (y/n)')
    await new Promise(r => setTimeout(r, 10))
    pty.push(' just kidding more text')
    await new Promise(r => setTimeout(r, 80))
    expect(onMatch).not.toHaveBeenCalled()
  })

  it('does NOT match when AI assistant content contains the prompt', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const emitter = { getLatestAssistantContent: () => 'Some advice ending with Approve? (y/n)' }
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20, emitter })
    det.start()
    pty.push('Some advice ending with Approve? (y/n)')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).not.toHaveBeenCalled()
  })

  it('matches Continue? [Y/n]', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push('Continue? [Y/n] ')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalled()
  })

  it('matches apply patch?', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push('apply patch? [y/N] ')
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalled()
  })

  // 用户回归：新版 codex-cli / gpt-5-codex 的权限框是多行 markdown 形态，
  // 老的单行 [y/N] / apply patch? regex 全部失配 → PTY 卡住、IM 收不到卡片
  it('matches new multi-line Codex permission prompt (Would you like to run + 3 numbered options + (esc))', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    pty.push([
      'Running date',
      '',
      'Would you like to run the following command?',
      '',
      'Reason: 是否允许我运行一次只读的 date 命令来验证 Codex bash 授权链路？',
      '',
      '$ date',
      '',
      '1. Yes, proceed (y)',
      '2. Yes, and don\'t ask again for commands that start with `date` (p)',
      '3. No, and tell Codex what to do differently (esc)',
    ].join('\n'))
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(1)
    const arg = onMatch.mock.calls[0][0]
    expect(arg.promptText).toContain('Would you like to run')
    expect(arg.promptText).toContain('1. Yes, proceed (y)')
    expect(arg.promptText).toContain('3. No, and tell Codex')
    expect(arg.matchedPattern).toBe('codex_new_multiline')
  })

  it('new multi-line Codex prompt is NOT matched if (esc) option is missing', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    // AI 自由回复可能恰好有"Would you like to" + 数字列表，但绝不会带 hotkey (esc)
    pty.push([
      'Would you like to try one?',
      '1. 方案 A 改动小',
      '2. 方案 B 性能好',
      '3. 方案 C 易维护',
    ].join('\n'))
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).not.toHaveBeenCalled()
  })

  it('new multi-line Codex prompt: only fires once per same prompt (dedup)', async () => {
    const onMatch = vi.fn()
    const pty = fakePty()
    const det = createCodexPromptDetector({ pty, onMatch, debounceMs: 20 })
    det.start()
    const prompt = [
      'Would you like to run the following command?',
      '$ ls',
      '1. Yes, proceed (y)',
      '2. Yes, and don\'t ask again (p)',
      '3. No, and tell Codex what to do differently (esc)',
    ].join('\n')
    pty.push(prompt)
    await new Promise(r => setTimeout(r, 60))
    pty.push(prompt)   // TUI redraw 同一段 → 不应再 emit
    await new Promise(r => setTimeout(r, 60))
    expect(onMatch).toHaveBeenCalledTimes(1)
  })
})
