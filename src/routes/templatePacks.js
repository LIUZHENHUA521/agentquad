import { Router } from 'express'
import { availablePacks, getPackEntries } from '../templates/packs.js'

export function createTemplatePacksRouter({ db }) {
  const router = Router()

  router.get('/', (_req, res) => {
    try {
      const installed = new Set(db.listInstalledPacks())
      const packs = availablePacks().map(p => ({
        ...p,
        installed: installed.has(p.id),
        installedCount: db.installedCountForPack(p.id),
        installedCategories: db.installedCategoriesForPack(p.id),
      }))
      res.json({ ok: true, packs })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:id/install', (req, res) => {
    try {
      const categories = Array.isArray(req.body?.categories) ? req.body.categories : null
      // Distinguish "no filter" (null → install all) from "empty selection" (empty array → install nothing).
      let entries
      if (categories === null) {
        entries = getPackEntries(req.params.id)
      } else if (categories.length === 0) {
        // Empty selection: still validate the pack exists, then install nothing.
        const all = getPackEntries(req.params.id)
        if (!all) { res.status(404).json({ ok: false, error: 'pack_not_found' }); return }
        entries = []
      } else {
        entries = getPackEntries(req.params.id, categories)
      }
      if (!entries) { res.status(404).json({ ok: false, error: 'pack_not_found' }); return }
      // Clean-slate: wipe existing pack rows first, then install the new selection.
      // For "install all" (categories null), this also makes the call idempotent.
      db.uninstallPack(req.params.id)
      if (entries.length > 0) {
        db.installPack(req.params.id, entries)
      }
      res.json({ ok: true, installed: entries.length, categories: categories || null })
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
