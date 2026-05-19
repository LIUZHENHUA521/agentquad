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
        installedNames: db.installedNamesForPack(p.id),
      }))
      res.json({ ok: true, packs })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  router.post('/:id/install', (req, res) => {
    try {
      const categoriesRaw = req.body?.categories
      const namesRaw = req.body?.names
      const categories = Array.isArray(categoriesRaw) ? categoriesRaw : null
      const names = Array.isArray(namesRaw) ? namesRaw : null
      // No filter at all → install everything.
      // Empty array on either filter → caller explicitly selected nothing → install nothing.
      const noFilter = categories === null && names === null
      const explicitEmpty =
        (categories !== null && categories.length === 0 && names === null) ||
        (names !== null && names.length === 0 && categories === null)
      let entries
      if (noFilter) {
        entries = getPackEntries(req.params.id)
      } else if (explicitEmpty) {
        const all = getPackEntries(req.params.id)
        if (!all) { res.status(404).json({ ok: false, error: 'pack_not_found' }); return }
        entries = []
      } else {
        entries = getPackEntries(req.params.id, { categories, names })
      }
      if (!entries) { res.status(404).json({ ok: false, error: 'pack_not_found' }); return }
      // Clean-slate: wipe existing pack rows first, then install the new selection.
      db.uninstallPack(req.params.id)
      if (entries.length > 0) {
        db.installPack(req.params.id, entries)
      }
      res.json({
        ok: true,
        installed: entries.length,
        categories: categories,
        names: names,
      })
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
