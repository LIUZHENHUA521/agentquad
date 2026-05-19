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
          body: body ? JSON.stringify(body) : undefined,
        })
        const data = await res.json()
        resolve({ status: res.status, data })
      } catch (e) { reject(e) }
      finally { server.close() }
    })
  })
}

describe('GET /api/template-packs', () => {
  let tmpDir, db, app
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aq-pkroute-'))
    db = openDb({ dataDir: tmpDir })
    app = makeApp(db)
  })
  afterEach(() => { db.close?.(); rmSync(tmpDir, { recursive: true, force: true }) })

  it('lists agency-agents pack as available, not installed', async () => {
    const { status, data } = await req(app, 'GET', '/api/template-packs')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    const agency = data.packs.find(p => p.id === 'agency-agents')
    expect(agency).toBeTruthy()
    expect(agency.installed).toBe(false)
    expect(agency.entryCount).toBeGreaterThanOrEqual(180)
    expect(agency.license).toBe('MIT')
  })

  it('install endpoint inserts all pack entries', async () => {
    const { status, data } = await req(app, 'POST', '/api/template-packs/agency-agents/install')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.installed).toBeGreaterThanOrEqual(180)
    const installed = db.listTemplates().filter(t => t.pack === 'agency-agents')
    expect(installed.length).toBe(data.installed)
  })

  it('uninstall endpoint removes all pack rows', async () => {
    await req(app, 'POST', '/api/template-packs/agency-agents/install')
    const { status, data } = await req(app, 'POST', '/api/template-packs/agency-agents/uninstall')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(db.listTemplates().filter(t => t.pack === 'agency-agents')).toHaveLength(0)
  })

  it('install endpoint 404s for unknown pack', async () => {
    const { status, data } = await req(app, 'POST', '/api/template-packs/nope/install')
    expect(status).toBe(404)
    expect(data.ok).toBe(false)
  })
})
