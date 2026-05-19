import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb } from '../src/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sampleEntries = [
  { slug: 'eng-a', category: 'engineering', name: '工程师 A', description: '描述 A', content: 'body A' },
  { slug: 'eng-b', category: 'engineering', name: '工程师 B', description: '描述 B', content: 'body B' },
]

describe('pack registry', () => {
  let tmpDir, db
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aq-pack-'))
    db = openDb({ dataDir: tmpDir })
  })
  afterEach(() => { db.close?.(); rmSync(tmpDir, { recursive: true, force: true }) })

  it('installPack inserts builtin rows with pack/category populated', () => {
    db.installPack('agency-agents', sampleEntries)
    const rows = db.listTemplates().filter(t => t.pack === 'agency-agents')
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.builtin)).toBe(true)
    expect(rows.every(r => r.category === 'engineering')).toBe(true)
  })

  it('installPack is idempotent — second call does not duplicate', () => {
    db.installPack('agency-agents', sampleEntries)
    db.installPack('agency-agents', sampleEntries)
    const rows = db.listTemplates().filter(t => t.pack === 'agency-agents')
    expect(rows).toHaveLength(2)
  })

  it('uninstallPack removes pack rows but leaves user copies untouched', () => {
    db.installPack('agency-agents', sampleEntries)
    const installed = db.listTemplates().find(t => t.pack === 'agency-agents')
    // user copy of an installed agent — builtin=0
    const userCopy = db.createTemplate({
      name: installed.name + ' (我的)',
      description: 'copy',
      content: installed.content,
    })
    db.uninstallPack('agency-agents')
    const remaining = db.listTemplates()
    expect(remaining.find(t => t.pack === 'agency-agents')).toBeUndefined()
    expect(remaining.find(t => t.id === userCopy.id)).toBeTruthy()
  })

  it('listInstalledPacks returns ids of packs with at least one row', () => {
    expect(db.listInstalledPacks()).toEqual([])
    db.installPack('agency-agents', sampleEntries)
    expect(db.listInstalledPacks()).toEqual(['agency-agents'])
  })
})
