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
    }
  }).filter(Boolean)
}

export function getPackEntries(id) {
  const data = load(id)
  if (!data) return null
  return data.entries.map(e => ({
    name: e.name,
    description: e.description,
    content: e.content,
    category: e.category,
  }))
}
