import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import { openDb } from '../src/db.js'
import { createTemplatePacksRouter } from '../src/routes/templatePacks.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeApp(db) {
  const app = express()
  app.use(express.json())
  app.use('/api/template-packs', createTemplatePacksRouter({ db }))
  return app
}

async function req(app, method, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const port = server.address().port
      try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        const data = await res.json()
        resolve({ status: res.status, data })
      } catch (e) { reject(e) }
      finally { server.close() }
    })
  })
}

describe('Template packs router', () => {
  let tmpDir, db, app
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aq-pkroute-'))
    db = openDb({ dataDir: tmpDir })
    app = makeApp(db)
  })
  afterEach(() => { db.close?.(); rmSync(tmpDir, { recursive: true, force: true }) })

  it('GET lists agency-agents with categories breakdown', async () => {
    const { status, data } = await req(app, 'GET', '/api/template-packs')
    expect(status).toBe(200)
    const agency = data.packs.find(p => p.id === 'agency-agents')
    expect(agency).toBeTruthy()
    expect(agency.installed).toBe(false)
    expect(agency.entryCount).toBeGreaterThanOrEqual(180)
    expect(Array.isArray(agency.categories)).toBe(true)
    expect(agency.categories.length).toBeGreaterThanOrEqual(10)
    for (const c of agency.categories) {
      expect(typeof c.slug).toBe('string')
      expect(typeof c.label).toBe('string')
      expect(c.count).toBeGreaterThan(0)
    }
    expect(agency.installedCount).toBe(0)
    expect(agency.installedCategories).toEqual([])
  })

  it('install with no body installs all entries', async () => {
    const { status, data } = await req(app, 'POST', '/api/template-packs/agency-agents/install')
    expect(status).toBe(200)
    expect(data.installed).toBeGreaterThanOrEqual(180)
    expect(db.installedCountForPack('agency-agents')).toBe(data.installed)
  })

  it('install with categories filters to those', async () => {
    const { status, data } = await req(app, 'POST', '/api/template-packs/agency-agents/install', { categories: ['engineering', 'design'] })
    expect(status).toBe(200)
    // engineering 29 + design 8 = 37 (per agency-agents.json)
    expect(data.installed).toBeGreaterThan(20)
    expect(data.installed).toBeLessThan(50)
    const cats = db.installedCategoriesForPack('agency-agents').sort()
    expect(cats).toEqual(['design', 'engineering'])
  })

  it('reinstall replaces categories (clean slate)', async () => {
    await req(app, 'POST', '/api/template-packs/agency-agents/install', { categories: ['engineering'] })
    const firstCount = db.installedCountForPack('agency-agents')
    expect(firstCount).toBeGreaterThan(20)
    await req(app, 'POST', '/api/template-packs/agency-agents/install', { categories: ['design'] })
    const cats = db.installedCategoriesForPack('agency-agents').sort()
    expect(cats).toEqual(['design'])
  })

  it('install with empty array uninstalls all', async () => {
    await req(app, 'POST', '/api/template-packs/agency-agents/install')
    expect(db.installedCountForPack('agency-agents')).toBeGreaterThan(0)
    const { status, data } = await req(app, 'POST', '/api/template-packs/agency-agents/install', { categories: [] })
    expect(status).toBe(200)
    expect(data.installed).toBe(0)
    expect(db.installedCountForPack('agency-agents')).toBe(0)
  })

  it('partial install preserves user-edited copies on subsequent install', async () => {
    await req(app, 'POST', '/api/template-packs/agency-agents/install', { categories: ['engineering'] })
    const installed = db.listTemplates().find(t => t.pack === 'agency-agents')
    const userCopy = db.createTemplate({
      name: installed.name + ' (我的)',
      description: 'copy',
      content: installed.content,
    })
    // Switch to a different category
    await req(app, 'POST', '/api/template-packs/agency-agents/install', { categories: ['design'] })
    const all = db.listTemplates()
    expect(all.find(t => t.id === userCopy.id)).toBeTruthy()
    expect(all.find(t => t.pack === 'agency-agents' && t.category === 'engineering')).toBeUndefined()
  })

  it('uninstall endpoint removes all pack rows', async () => {
    await req(app, 'POST', '/api/template-packs/agency-agents/install')
    const { status } = await req(app, 'POST', '/api/template-packs/agency-agents/uninstall')
    expect(status).toBe(200)
    expect(db.installedCountForPack('agency-agents')).toBe(0)
  })

  it('install endpoint 404s for unknown pack', async () => {
    const { status, data } = await req(app, 'POST', '/api/template-packs/nope/install')
    expect(status).toBe(404)
    expect(data.ok).toBe(false)
  })

  it('GET surfaces pack entries and installedNames for tree-picker UI', async () => {
    const { data } = await req(app, 'GET', '/api/template-packs')
    const agency = data.packs.find(p => p.id === 'agency-agents')
    expect(Array.isArray(agency.entries)).toBe(true)
    expect(agency.entries.length).toBe(agency.entryCount)
    const sample = agency.entries[0]
    expect(typeof sample.slug).toBe('string')
    expect(typeof sample.name).toBe('string')
    expect(typeof sample.category).toBe('string')
    expect(typeof sample.categoryLabel).toBe('string')
    expect(agency.installedNames).toEqual([])
  })

  it('install with names installs exactly those entries', async () => {
    const { data: listed } = await req(app, 'GET', '/api/template-packs')
    const agency = listed.packs.find(p => p.id === 'agency-agents')
    // Pick two arbitrary entries across two different categories.
    const byCat = new Map()
    for (const e of agency.entries) {
      if (!byCat.has(e.category)) byCat.set(e.category, e)
      if (byCat.size === 2) break
    }
    const picks = [...byCat.values()].map(e => e.name)
    const { status, data } = await req(
      app, 'POST', '/api/template-packs/agency-agents/install', { names: picks },
    )
    expect(status).toBe(200)
    expect(data.installed).toBe(picks.length)
    const { data: after } = await req(app, 'GET', '/api/template-packs')
    const agencyAfter = after.packs.find(p => p.id === 'agency-agents')
    expect(agencyAfter.installedNames.slice().sort()).toEqual(picks.slice().sort())
    expect(agencyAfter.installedCount).toBe(picks.length)
  })

  it('install names overrides previous selection (clean slate)', async () => {
    const { data: listed } = await req(app, 'GET', '/api/template-packs')
    const agency = listed.packs.find(p => p.id === 'agency-agents')
    const first = [agency.entries[0].name, agency.entries[1].name]
    const second = [agency.entries[2].name]
    await req(app, 'POST', '/api/template-packs/agency-agents/install', { names: first })
    await req(app, 'POST', '/api/template-packs/agency-agents/install', { names: second })
    const { data } = await req(app, 'GET', '/api/template-packs')
    const agencyAfter = data.packs.find(p => p.id === 'agency-agents')
    expect(agencyAfter.installedNames).toEqual(second)
  })

  it('install with empty names array uninstalls all', async () => {
    await req(app, 'POST', '/api/template-packs/agency-agents/install')
    expect(db.installedCountForPack('agency-agents')).toBeGreaterThan(0)
    const { status, data } = await req(
      app, 'POST', '/api/template-packs/agency-agents/install', { names: [] },
    )
    expect(status).toBe(200)
    expect(data.installed).toBe(0)
    expect(db.installedCountForPack('agency-agents')).toBe(0)
  })
})
