import { Router } from 'express'
import { availablePacks, getPackEntries } from '../templates/packs.js'

export function createTemplatePacksRouter({ db }) {
  const router = Router()

  router.get('/', (_req, res) => {
    try {
      const installed = new Set(db.listInstalledPacks())
      const packs = availablePacks().map(p => ({ ...p, installed: installed.has(p.id) }))
      res.json({ ok: true, packs })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:id/install', (req, res) => {
    try {
      const entries = getPackEntries(req.params.id)
      if (!entries) { res.status(404).json({ ok: false, error: 'pack_not_found' }); return }
      db.installPack(req.params.id, entries)
      res.json({ ok: true, installed: entries.length })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:id/uninstall', (req, res) => {
    try {
      db.uninstallPack(req.params.id)
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return router
}
