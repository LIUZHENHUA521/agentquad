import { describe, it, expect } from 'vitest'
import { cleanPtyTail, parsePermissionOptions, extractPermissionPrompt, formatToolUseAsPrompt, CLAUDE_DEFAULT_PERMISSION_OPTIONS } from '../src/permission-prompt.js'

describe('permission-prompt', () => {
  describe('cleanPtyTail', () => {
    it('strips ANSI CSI/OSC sequences', () => {
      const raw = '\x1b[1;32mHello\x1b[0m \x1b]0;title\x07world'
      expect(cleanPtyTail(raw)).toBe('Hello world')
    })

    it('strips box-drawing characters but preserves inner text', () => {
      const raw = '╭───────────╮\n│ Hello box │\n╰───────────╯'
      const out = cleanPtyTail(raw)
      expect(out).toContain('Hello box')
      expect(out).not.toMatch(/[│╭╮╯╰─]/)
    })

    it('drops decorative ❯ marker lines and trims marker prefix', () => {
      const raw = '❯ 1. Yes\n  2. No\n❯'
      const out = cleanPtyTail(raw)
      expect(out).toContain('1. Yes')
      expect(out).toContain('2. No')
      // 末尾光秃的 ❯ 行被丢弃
      expect(out.trim().endsWith('❯')).toBe(false)
    })

    it('collapses multiple blank lines', () => {
      const raw = 'a\n\n\n\nb'
      expect(cleanPtyTail(raw)).toBe('a\n\nb')
    })
  })

  describe('parsePermissionOptions', () => {
    it('extracts numbered options', () => {
      const text = 'Do you want to proceed?\n1. Yes\n2. Yes, and don\'t ask again\n3. No, suggest changes'
      const opts = parsePermissionOptions(text)
      expect(opts).toEqual([
        { index: 1, label: 'Yes' },
        { index: 2, label: "Yes, and don't ask again" },
        { index: 3, label: 'No, suggest changes' },
      ])
    })

    it('returns empty when no enumerated choices (Codex y/n style)', () => {
      const text = 'apply patch?\n[Y/n]'
      expect(parsePermissionOptions(text)).toEqual([])
    })

    it('de-duplicates repeated index, keeps first', () => {
      const text = '1. First\n1. Second'
      expect(parsePermissionOptions(text)).toEqual([{ index: 1, label: 'First' }])
    })
  })

  describe('extractPermissionPrompt', () => {
    it('returns trimmed text + options for a typical Claude permission prompt', () => {
      const raw = [
        '\x1b[36m╭────────────────────────────╮\x1b[0m',
        '│ Bash command               │',
        '│   curl -s ...              │',
        '│                            │',
        '│ Do you want to proceed?    │',
        '│ \x1b[33m❯\x1b[0m 1. Yes                  │',
        '│   2. No, suggest changes   │',
        '╰────────────────────────────╯',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('Do you want to proceed?')
      expect(text).toContain('1. Yes')
      expect(text).toContain('2. No, suggest changes')
      expect(options).toEqual([
        { index: 1, label: 'Yes' },
        { index: 2, label: 'No, suggest changes' },
      ])
    })

    it('returns empty {} for empty input', () => {
      expect(extractPermissionPrompt('')).toEqual({ text: '', options: [] })
      expect(extractPermissionPrompt(null)).toEqual({ text: '', options: [] })
    })

    it('caps text by maxLines + maxChars', () => {
      const long = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
      const { text } = extractPermissionPrompt(long, { maxLines: 5, maxChars: 100 })
      const lines = text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(5)
      expect(text.length).toBeLessThanOrEqual(100)
    })

    it('handles Codex [Y/n] style — text but no options', () => {
      const raw = 'apply patch?\n[Y/n]'
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('apply patch?')
      expect(text).toContain('[Y/n]')
      expect(options).toEqual([])
    })

    it('用 historicalRaw 兜底：recentOutput 全是 spinner，历史里有真 prompt', () => {
      // recentOutput 模拟：被 spinner 反复刷屏覆盖到只剩噪声
      const noisy = Array.from({ length: 30 }, () => '✶ Skedaddling for 12s ✶').join('\n')
      // 5MB outputHistory 的尾部模拟：完整的 Claude 授权弹窗
      const real = [
        '\x1b[36m╭────────────────────────────╮\x1b[0m',
        '│ Bash command               │',
        '│   curl -s -X POST https://api/x.com -d \'{"a":1}\' │',
        '│   Contains shell syntax    │',
        '│                            │',
        '│ Do you want to proceed?    │',
        '│ ❯ 1. Yes                   │',
        '│   2. No, suggest changes   │',
        '╰────────────────────────────╯',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(noisy, { historicalRaw: real })
      expect(text).toContain('curl -s -X POST')
      expect(text).toContain('Do you want to proceed?')
      expect(options).toEqual([
        { index: 1, label: 'Yes' },
        { index: 2, label: 'No, suggest changes' },
      ])
    })

    it('锚点定位：prompt 在中间时窗口包含上下文（Bash 命令文本）', () => {
      // 真实 PTY 场景：上方是 prompt + 选项，下方是 spinner 噪声继续刷
      const raw = [
        'Bash command',
        '  curl https://example.com/foo',
        '  Contains shell syntax',
        '',
        'Do you want to proceed?',
        '1. Yes',
        '2. No',
        '✶ Cooking for 3s ✶',
        '✶ Cooking for 5s ✶',
        '✶ Cooking for 8s ✶',
      ].join('\n')
      const { text, options } = extractPermissionPrompt(raw)
      expect(text).toContain('Bash command')
      expect(text).toContain('curl https://example.com/foo')
      expect(text).toContain('Do you want to proceed?')
      expect(options.map(o => o.label)).toEqual(['Yes', 'No'])
    })

    it('formatToolUseAsPrompt: Bash 命令直出', () => {
      const out = formatToolUseAsPrompt({
        name: 'Bash',
        input: { command: 'echo "test-$(uname -s)" && find /tmp -maxdepth 1 -type f | head -3', description: 'Demo command' },
      })
      expect(out).toContain('Bash:')
      expect(out).toContain('echo "test-$(uname -s)"')
      expect(out).toContain('Demo command')
    })

    it('formatToolUseAsPrompt: Edit/Write 用 file_path', () => {
      const out = formatToolUseAsPrompt({ name: 'Edit', input: { file_path: '/repo/src/foo.js' } })
      expect(out).toBe('Edit:\n/repo/src/foo.js')
    })

    it('formatToolUseAsPrompt: 未知工具回退到 JSON', () => {
      const out = formatToolUseAsPrompt({ name: 'Weird', input: { weird_field: 'x', other: 42 } })
      expect(out).toContain('Weird:')
      expect(out).toContain('weird_field')
    })

    it('CLAUDE_DEFAULT_PERMISSION_OPTIONS 包含 3 个标准选项', () => {
      expect(CLAUDE_DEFAULT_PERMISSION_OPTIONS).toHaveLength(3)
      expect(CLAUDE_DEFAULT_PERMISSION_OPTIONS[0]).toEqual({ index: 1, label: 'Yes' })
    })

    it('过滤 spinner / status verb / auto mode / TUI 前缀单独行', () => {
      const raw = [
        '✶ ✶ ✶',
        'Brewing for 30s',
        'Reading…',
        '❯',
        'auto mode on',
        'shift+tab to cycle',
        'Real content here',
        'Do you want to proceed?',
        '1. Yes',
      ].join('\n')
      const { text } = extractPermissionPrompt(raw)
      expect(text).toContain('Real content here')
      expect(text).toContain('Do you want to proceed?')
      expect(text).not.toMatch(/Brewing for/)
      expect(text).not.toMatch(/Reading…/)
      expect(text).not.toMatch(/auto mode/i)
    })
  })
})
