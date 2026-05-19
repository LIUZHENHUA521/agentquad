import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PACK = JSON.parse(readFileSync(
  join(process.cwd(), 'src', 'templates', 'packs', 'agency-agents.json'),
  'utf8',
))

describe('agency-agents.json built pack', () => {
  it('declares pack metadata', () => {
    expect(PACK.id).toBe('agency-agents')
    expect(PACK.license).toBe('MIT')
    expect(PACK.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('contains a sensible number of entries (≥180, ≤300)', () => {
    expect(PACK.entries.length).toBeGreaterThanOrEqual(180)
    expect(PACK.entries.length).toBeLessThanOrEqual(300)
  })

  it('every entry has the merged shape', () => {
    for (const e of PACK.entries) {
      expect(typeof e.slug).toBe('string')
      expect(e.slug.length).toBeGreaterThan(0)
      expect(typeof e.category).toBe('string')
      expect(typeof e.categoryLabel).toBe('string')
      expect(typeof e.name).toBe('string')
      expect(typeof e.nameEn).toBe('string')
      expect(typeof e.description).toBe('string')
      expect(typeof e.content).toBe('string')
      expect(e.content.length).toBeGreaterThan(50)
    }
  })

  it('emoji is prefixed into description when source had emoji', () => {
    const withEmoji = PACK.entries.find(e => e.emoji)
    expect(withEmoji).toBeTruthy()
    expect(withEmoji.description.startsWith(withEmoji.emoji)).toBe(true)
  })

  it('slugs are unique', () => {
    const set = new Set(PACK.entries.map(e => e.slug))
    expect(set.size).toBe(PACK.entries.length)
  })
})
