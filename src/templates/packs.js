import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACK_DIR = join(__dirname, 'packs')

const AVAILABLE = [
  { id: 'agency-agents', file: 'agency-agents.json' },
]

const cache = new Map()

function load(id) {
  if (cache.has(id)) return cache.get(id)
  const meta = AVAILABLE.find(p => p.id === id)
  if (!meta) return null
  const path = join(PACK_DIR, meta.file)
  if (!existsSync(path)) return null
  const data = JSON.parse(readFileSync(path, 'utf8'))
  cache.set(id, data)
  return data
}

export function getPackCategories(id) {
  const data = load(id)
  if (!data) return null
  const byCat = new Map()
  for (const e of data.entries) {
    if (!byCat.has(e.category)) {
      byCat.set(e.category, { slug: e.category, label: e.categoryLabel, count: 0 })
    }
    byCat.get(e.category).count++
  }
  return [...byCat.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

export function getPackEntryMeta(id) {
  const data = load(id)
  if (!data) return null
  return data.entries.map(e => ({
    slug: e.slug,
    name: e.name,
    nameEn: e.nameEn,
    description: e.description,
    emoji: e.emoji,
    category: e.category,
    categoryLabel: e.categoryLabel,
  }))
}

export function availablePacks() {
  return AVAILABLE.map(({ id }) => {
    const data = load(id)
    if (!data) return null
    return {
      id: data.id,
      version: data.version,
      source: data.source,
      license: data.license,
      attribution: data.attribution,
      entryCount: data.entries.length,
      categories: getPackCategories(id),
      entries: getPackEntryMeta(id),
    }
  }).filter(Boolean)
}

export function getPackEntries(id, filter) {
  const data = load(id)
  if (!data) return null
  // Accept legacy positional (array of category slugs) or object { categories, names }.
  let categories = null
  let names = null
  if (Array.isArray(filter)) {
    categories = filter
  } else if (filter && typeof filter === 'object') {
    if (Array.isArray(filter.categories)) categories = filter.categories
    if (Array.isArray(filter.names)) names = filter.names
  }
  const catSet = categories && categories.length > 0 ? new Set(categories) : null
  const nameSet = names && names.length > 0 ? new Set(names) : null
  return data.entries
    .filter(e => {
      if (nameSet && !nameSet.has(e.name)) return false
      if (catSet && !catSet.has(e.category)) return false
      return true
    })
    .map(e => ({
      name: e.name,
      description: e.description,
      content: e.content,
      category: e.category,
    }))
}
