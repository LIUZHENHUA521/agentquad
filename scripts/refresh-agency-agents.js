#!/usr/bin/env node
// Fetch all agent markdown files from msitarzewski/agency-agents at a pinned
// commit SHA, parse the YAML-ish frontmatter, and emit src/templates/packs/agency-agents.raw.json.
//
// Re-run this script (and commit the diff) to bump to a newer upstream commit.
// Configure the pin via PIN env var or edit the SHA constant below.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA = process.env.AGENCY_AGENTS_SHA || '783f6a72bfd7f3135700ac273c619d92821b419a'
const CATEGORIES = [
  'academic', 'design', 'engineering', 'finance', 'game-development',
  'marketing', 'paid-media', 'product', 'project-management', 'sales',
  'spatial-computing', 'specialized', 'strategy', 'support', 'testing',
]

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(__dirname, '..', 'src', 'templates', 'packs', 'agency-agents.raw.json')

async function gh(path) {
  const url = `https://api.github.com/repos/msitarzewski/agency-agents/contents/${path}?ref=${SHA}`
  const headers = { 'User-Agent': 'agentquad-refresh', 'Accept': 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${await res.text()}`)
  return res.json()
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return { fm: {}, body: md }
  const raw = m[1], body = m[2]
  const fm = {}
  let key = null, buf = []
  for (const lineRaw of raw.split('\n')) {
    const m2 = lineRaw.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (m2) {
      if (key) fm[key] = buf.join('\n').trim().replace(/^["']|["']$/g, '')
      key = m2[1]; buf = [m2[2]]
    } else {
      buf.push(lineRaw.trim())
    }
  }
  if (key) fm[key] = buf.join('\n').trim().replace(/^["']|["']$/g, '')
  return { fm, body: body.trim() }
}

// Recursively walk a category tree. `dirPath` is the full path from repo root
// (e.g. `game-development` or `game-development/unity`). `relPath` is the path
// relative to the category root (e.g. `` or `unity`), used to derive a slug
// that's unique across nested files. Slug convention: relative path inside the
// category with `.md` stripped and `/` replaced by `-`, so
// `game-development/unity/unity-architect.md` => slug `unity-unity-architect`.
// Top-level files keep their bare filename slug (e.g. `engineering-ai-engineer`).
// The frontmatter `name:` check filters out non-agent docs like
// EXECUTIVE-BRIEF.md / QUICKSTART.md which lack proper agent frontmatter.
async function fetchDir(cat, dirPath, relPath, counts) {
  const list = await gh(dirPath)
  const out = []
  for (const f of list) {
    if (f.type === 'dir') {
      const childRel = relPath ? `${relPath}/${f.name}` : f.name
      const nested = await fetchDir(cat, `${dirPath}/${f.name}`, childRel, counts)
      out.push(...nested)
      continue
    }
    if (!f.name.endsWith('.md')) continue
    const file = await gh(`${dirPath}/${f.name}`)
    const md = Buffer.from(file.content, 'base64').toString('utf8')
    const { fm, body } = parseFrontmatter(md)
    if (!fm.name) {
      console.warn(`[skip] ${dirPath}/${f.name} — no frontmatter name`)
      continue
    }
    const relFile = relPath ? `${relPath}/${f.name}` : f.name
    const slug = relFile.replace(/\.md$/, '').replace(/\//g, '-')
    if (relPath) counts.nested += 1
    else counts.top += 1
    out.push({
      slug,
      category: cat,
      emoji: fm.emoji || '',
      nameEn: fm.name,
      descriptionEn: fm.description || '',
      content: body,
    })
  }
  return out
}

async function fetchCategory(cat) {
  const counts = { top: 0, nested: 0 }
  const entries = await fetchDir(cat, cat, '', counts)
  return { entries, counts }
}

async function main() {
  const all = []
  for (const cat of CATEGORIES) {
    process.stderr.write(`[fetch] ${cat} … `)
    const { entries, counts } = await fetchCategory(cat)
    process.stderr.write(`${counts.top} + nested ${counts.nested} = ${entries.length}\n`)
    all.push(...entries)
  }
  const payload = {
    id: 'agency-agents',
    version: SHA.slice(0, 8),
    sha: SHA,
    source: 'https://github.com/msitarzewski/agency-agents',
    license: 'MIT',
    attribution: 'msitarzewski/agency-agents',
    fetchedAt: new Date().toISOString(),
    entries: all,
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${all.length} entries to ${OUT_PATH}`)
}

main().catch(err => { console.error(err); process.exit(1) })
