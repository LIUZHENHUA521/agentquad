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
})
