import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb } from '../src/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('prompt_templates schema migration: pack + category', () => {
  let tmpDir
  let db
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aq-pt-migrate-'))
    db = openDb({ dataDir: tmpDir })
  })
  afterEach(() => {
    db.close?.()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exposes pack and category columns on prompt_templates', () => {
    const cols = db.raw().prepare(`PRAGMA table_info(prompt_templates)`).all().map(c => c.name)
    expect(cols).toContain('pack')
    expect(cols).toContain('category')
  })

  it('listTemplates() yields pack=null and category=null for native 8 builtins', () => {
    const list = db.listTemplates()
    expect(list.length).toBeGreaterThanOrEqual(8)
    const native = list.filter(t => t.builtin)
    for (const row of native) {
      expect(row.pack).toBeNull()
      expect(row.category).toBeNull()
    }
  })
})
