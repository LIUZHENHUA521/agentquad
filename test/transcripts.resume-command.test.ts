import { describe, expect, it } from 'vitest'
import { buildResumeCommand, posixEscape } from '../web/src/transcripts/resumeCommand.ts'

describe('posixEscape', () => {
  it('wraps simple strings in single quotes', () => {
    expect(posixEscape('hello')).toBe("'hello'")
  })

  it('escapes single quotes by closing, escaping, reopening', () => {
    expect(posixEscape("O'Reilly")).toBe("'O'\\''Reilly'")
  })

  it('handles empty string', () => {
    expect(posixEscape('')).toBe("''")
  })

  it('preserves spaces and slashes inside the quoted body', () => {
    expect(posixEscape('/Users/x/some dir')).toBe("'/Users/x/some dir'")
  })
})

describe('buildResumeCommand', () => {
  const ID = 'abcd1234-ef56-7890-1234-567890abcdef'

  it('claude with cwd → cd && claude --resume', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: '/Users/x/proj' })
    expect(r.command).toBe(`cd '/Users/x/proj' && claude --resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('claude with null cwd → bare claude --resume + cwd_missing warning', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: null })
    expect(r.command).toBe(`claude --resume '${ID}'`)
    expect(r.warnings).toEqual(['cwd_missing'])
  })

  it('claude with empty-string cwd → bare command + cwd_missing warning', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: '' })
    expect(r.command).toBe(`claude --resume '${ID}'`)
    expect(r.warnings).toEqual(['cwd_missing'])
  })

  it('codex with cwd → cd && codex resume (no --)', () => {
    const r = buildResumeCommand({ tool: 'codex', native_id: ID, cwd: '/x' })
    expect(r.command).toBe(`cd '/x' && codex resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('cursor with cwd → cd && cursor-agent --resume', () => {
    const r = buildResumeCommand({ tool: 'cursor', native_id: ID, cwd: '/x' })
    expect(r.command).toBe(`cd '/x' && cursor-agent --resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('escapes single quotes inside cwd', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: "/Users/O'Reilly/x" })
    expect(r.command).toBe(`cd '/Users/O'\\''Reilly/x' && claude --resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('throws on unsupported tool', () => {
    expect(() => buildResumeCommand({ tool: 'unknown' as never, native_id: ID, cwd: '/x' })).toThrow(/unsupported tool/)
  })

  it('throws on empty native_id', () => {
    expect(() => buildResumeCommand({ tool: 'claude', native_id: '', cwd: '/x' })).toThrow(/native_id/)
  })
})
