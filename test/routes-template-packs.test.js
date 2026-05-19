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
})
