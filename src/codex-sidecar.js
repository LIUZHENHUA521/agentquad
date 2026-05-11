import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ROOT_DIR } from './config.js'

const DEFAULT_DIR = join(DEFAULT_ROOT_DIR, 'codex-sessions')

export function createCodexSidecar({ baseDir = DEFAULT_DIR } = {}) {
  mkdirSync(baseDir, { recursive: true })
  const memory = new Map()

  function fileFor(nativeId) {
    return join(baseDir, `${nativeId}.json`)
  }

  function lookup(nativeId) {
    if (!nativeId) return null
    if (memory.has(nativeId)) return memory.get(nativeId)
    const path = fileFor(nativeId)
    if (!existsSync(path)) return null
    try {
      const j = JSON.parse(readFileSync(path, 'utf8'))
      const v = { quadtodoSessionId: j.quadtodoSessionId, todoId: j.todoId, cwd: j.cwd }
      memory.set(nativeId, v)
      return v
    } catch { return null }
  }

  async function write({ nativeId, quadtodoSessionId, todoId, cwd }) {
    if (!nativeId) throw new Error('nativeId_required')
    memory.set(nativeId, { quadtodoSessionId, todoId, cwd })
    const payload = { nativeId, quadtodoSessionId, todoId, cwd, ts: Date.now() }
    writeFileSync(fileFor(nativeId), JSON.stringify(payload), 'utf8')
  }

  function restoreFromDisk() {
    if (!existsSync(baseDir)) return
    for (const name of readdirSync(baseDir)) {
      if (!name.endsWith('.json')) continue
      try {
        const j = JSON.parse(readFileSync(join(baseDir, name), 'utf8'))
        if (j.nativeId) memory.set(j.nativeId, { quadtodoSessionId: j.quadtodoSessionId, todoId: j.todoId, cwd: j.cwd })
      } catch {}
    }
  }

  function clear(nativeId) {
    memory.delete(nativeId)
    try { unlinkSync(fileFor(nativeId)) } catch {}
  }

  return { write, lookup, restoreFromDisk, clear }
}
