import { describe, it, expect } from 'vitest'
import { cleanPtyTail, parsePermissionOptions, extractPermissionPrompt } from '../src/permission-prompt.js'

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
  })
})
