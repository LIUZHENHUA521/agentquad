import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb } from '../src/db.js'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('prompt_templates upgrade from pre-pack schema', () => {
  let tmpDir
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aq-upgrade-'))
  })
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedPreMigrationDb() {
    const dbPath = join(tmpDir, 'data.db')
    const raw = new Database(dbPath)
    // Recreate the pre-pack-feature schema (no `pack`, no `category` columns)
    raw.exec(`
      CREATE TABLE prompt_templates (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content     TEXT NOT NULL,
        builtin     INTEGER NOT NULL DEFAULT 0,
        sort_order  REAL NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_pt_sort ON prompt_templates(sort_order);
    `)
    raw.prepare(`
      INSERT INTO prompt_templates (id, name, description, content, builtin, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-uuid-1', 'Old Builtin', 'old desc', 'old body', 1, 0, Date.now(), Date.now())
    raw.close()
    return dbPath
  }

  it('migrates a pre-feature db without throwing', () => {
    const dbPath = seedPreMigrationDb()
    // Should not throw
    const db = openDb({ dataDir: tmpDir })
    const cols = db.raw().prepare(`PRAGMA table_info(prompt_templates)`).all().map(c => c.name)
    expect(cols).toContain('pack')
    expect(cols).toContain('category')
    db.close?.()
  })

  it('preserves existing rows during migration', () => {
    seedPreMigrationDb()
    const db = openDb({ dataDir: tmpDir })
    const list = db.listTemplates()
    const legacy = list.find(t => t.name === 'Old Builtin')
    expect(legacy).toBeTruthy()
    expect(legacy.builtin).toBe(true)
    expect(legacy.pack).toBeNull()
    expect(legacy.category).toBeNull()
    db.close?.()
  })

  it('creates idx_pt_pack index after migration', () => {
    seedPreMigrationDb()
    const db = openDb({ dataDir: tmpDir })
    const idx = db.raw().prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='prompt_templates'`,
    ).all().map(r => r.name)
    expect(idx).toContain('idx_pt_pack')
    db.close?.()
  })
})
