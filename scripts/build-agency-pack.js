#!/usr/bin/env node
// Merge agency-agents.raw.json + agency-agents.zh-CN.json into the shipped agency-agents.json.
// Run after refresh-agency-agents.js or whenever the translation overlay changes.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACK_DIR  = join(__dirname, '..', 'src', 'templates', 'packs')
const RAW_PATH  = join(PACK_DIR, 'agency-agents.raw.json')
const ZH_PATH   = join(PACK_DIR, 'agency-agents.zh-CN.json')
const OUT_PATH  = join(PACK_DIR, 'agency-agents.json')

const raw = JSON.parse(readFileSync(RAW_PATH, 'utf8'))
const zh  = JSON.parse(readFileSync(ZH_PATH,  'utf8'))

if (zh.version !== raw.version) {
  console.warn(`[warn] translation version ${zh.version} != raw version ${raw.version}`)
}

const entries = raw.entries.map(e => {
  const tr = zh.entries[e.slug]
  if (!tr) throw new Error(`Missing zh translation for slug "${e.slug}"`)
  const categoryLabel = zh.categories[e.category]
  if (!categoryLabel) throw new Error(`Missing zh categoryLabel for "${e.category}"`)
  const description = e.emoji ? `${e.emoji} ${tr.description}` : tr.description
  return {
    slug: e.slug,
    category: e.category,
    categoryLabel,
    emoji: e.emoji || '',
    name: tr.name,
    nameEn: e.nameEn,
    description,
    descriptionEn: e.descriptionEn,
    content: e.content,
  }
})

const pack = {
  id: 'agency-agents',
  version: raw.version,
  sha: raw.sha,
  source: raw.source,
  license: raw.license,
  attribution: raw.attribution,
  fetchedAt: raw.fetchedAt,
  builtAt: new Date().toISOString(),
  entries,
}

writeFileSync(OUT_PATH, JSON.stringify(pack, null, 2) + '\n', 'utf8')
console.log(`Built ${entries.length} entries → ${OUT_PATH}`)
