/**
 * Cursor Agent CLI hooks 安装器：
 *   - 把 hook entry 合并写入 `~/.cursor/hooks.json`，不破坏用户现有 hook
 *   - 写 `"version": 1` 协议头（Cursor 1.7+ 要求）
 *
 * Cursor 事件：stop（turn end）/ beforeSubmitPrompt（等用户）/ sessionEnd
 *
 * 合并策略：
 *   - 已有 hooks.<event> 数组 → append；不删除已有 entry
 *   - AgentQuad 加的 entry 用 `_agentquadManaged: true` 标记
 *   - hooks.json 不存在 → 创建（带 version:1）
 *   - hooks.json 损坏 → warn-skip
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DEFAULT_ROOT_DIR } from './config.js'

const MANAGED_KEY = '_agentquadManaged'
const HOOK_EVENTS = ['stop', 'beforeSubmitPrompt', 'sessionEnd']
const HOOK_VERSION_RE = /quadtodo-hook-version:\s*(\d+)/
const SCHEMA_VERSION = 1

function defaultHookScriptPath() {
  return join(DEFAULT_ROOT_DIR, 'cursor-hooks', 'notify.js')
}

function defaultHooksJsonPath() {
  return join(homedir(), '.cursor', 'hooks.json')
}

function defaultTemplatePath() {
  return fileURLToPath(new URL('./templates/cursor-hooks/notify.js', import.meta.url))
}

function defaultUninstallMarkerPath() {
  return join(DEFAULT_ROOT_DIR, 'cursor-hooks', '.uninstalled')
}

function parseHookVersion(content) {
  if (!content) return null
  const m = content.match(HOOK_VERSION_RE)
  return m ? Number(m[1]) : 0
}

function eventToArg(event) {
  if (event === 'beforeSubmitPrompt') return 'notification'
  if (event === 'sessionEnd') return 'session-end'
  return 'stop'
}

function buildHookEntry(event, hookScriptPath) {
  // Cursor 的 hook entry 是扁平的 object（不像 Claude 的 matcher+hooks 嵌套）
  return {
    type: 'command',
    command: `node ${hookScriptPath} ${eventToArg(event)}`,
    timeout: 30,
    [MANAGED_KEY]: true,
  }
}

function loadHooksJson(path) {
  if (!existsSync(path)) return { version: SCHEMA_VERSION }
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    const err = new Error(`cursor hooks.json malformed: ${e.message}`)
    err.code = 'malformed_hooks_json'
    err.path = path
    throw err
  }
}

function saveHooksJson(path, data) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function backupFile(path) {
  if (!existsSync(path)) return null
  const bak = `${path}.bak.${Date.now()}`
  copyFileSync(path, bak)
  return bak
}

export function installHooks({
  hooksPath = defaultHooksJsonPath(),
  hookScriptPath = defaultHookScriptPath(),
  events = HOOK_EVENTS,
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  clearUninstallMarker = true,
} = {}) {
  if (!existsSync(hookScriptPath)) {
    const err = new Error(`hook script not found: ${hookScriptPath}`)
    err.code = 'hook_script_missing'
    throw err
  }

  const data = loadHooksJson(hooksPath)
  const backup = backupFile(hooksPath)
  if (!data.version) data.version = SCHEMA_VERSION
  if (!data.hooks || typeof data.hooks !== 'object') data.hooks = {}

  const added = []
  for (const event of events) {
    if (!Array.isArray(data.hooks[event])) data.hooks[event] = []
    data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[MANAGED_KEY])
    data.hooks[event].push(buildHookEntry(event, hookScriptPath))
    added.push(event)
  }

  saveHooksJson(hooksPath, data)
  let markerCleared = false
  if (clearUninstallMarker && existsSync(uninstallMarkerPath)) {
    try { unlinkSync(uninstallMarkerPath); markerCleared = true } catch { /* ignore */ }
  }
  return { hooksPath, backup, added, skipped: [], markerCleared }
}

export function uninstallHooks({
  hooksPath = defaultHooksJsonPath(),
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  writeUninstallMarker = true,
} = {}) {
  let markerWritten = false
  const writeMarker = () => {
    if (!writeUninstallMarker) return
    try {
      const dir = dirname(uninstallMarkerPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(uninstallMarkerPath, `${new Date().toISOString()}\n`)
      markerWritten = true
    } catch { /* ignore */ }
  }

  if (!existsSync(hooksPath)) {
    writeMarker()
    return { hooksPath, removed: [], backup: null, markerWritten }
  }

  const data = loadHooksJson(hooksPath)
  const backup = backupFile(hooksPath)
  const removed = []

  if (data.hooks && typeof data.hooks === 'object') {
    for (const event of Object.keys(data.hooks)) {
      if (!Array.isArray(data.hooks[event])) continue
      const before = data.hooks[event].length
      data.hooks[event] = data.hooks[event].filter((entry) => !entry?.[MANAGED_KEY])
      if (data.hooks[event].length !== before) {
        removed.push({ event, removedCount: before - data.hooks[event].length })
      }
      if (data.hooks[event].length === 0) delete data.hooks[event]
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks
  }

  saveHooksJson(hooksPath, data)
  writeMarker()
  return { hooksPath, removed, backup, markerWritten }
}

export function inspectHooks({
  hooksPath = defaultHooksJsonPath(),
  hookScriptPath = defaultHookScriptPath(),
} = {}) {
  const scriptExists = existsSync(hookScriptPath)
  if (!existsSync(hooksPath)) {
    return { installed: false, eventsInstalled: [], hooksPath, hookScriptPath, scriptExists }
  }
  let data
  try {
    data = loadHooksJson(hooksPath)
  } catch (e) {
    return { installed: false, eventsInstalled: [], hooksPath, hookScriptPath, scriptExists, error: e.code }
  }
  const eventsInstalled = []
  for (const event of HOOK_EVENTS) {
    const arr = data?.hooks?.[event]
    if (!Array.isArray(arr)) continue
    if (arr.some((entry) => entry?.[MANAGED_KEY])) eventsInstalled.push(event)
  }
  return {
    installed: eventsInstalled.length === HOOK_EVENTS.length,
    eventsInstalled,
    hooksPath,
    hookScriptPath,
    scriptExists,
  }
}

export function deployHookScript({
  scriptPath = defaultHookScriptPath(),
  templatePath = defaultTemplatePath(),
} = {}) {
  if (!existsSync(templatePath)) {
    const err = new Error(`hook template not found: ${templatePath}`)
    err.code = 'hook_template_missing'
    throw err
  }
  const templateContent = readFileSync(templatePath, 'utf8')
  const templateVersion = parseHookVersion(templateContent)

  const dir = dirname(scriptPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const previousVersion = existsSync(scriptPath)
    ? parseHookVersion(readFileSync(scriptPath, 'utf8'))
    : null

  if (previousVersion !== null && previousVersion === templateVersion) {
    return { action: 'unchanged', version: templateVersion, previousVersion, scriptPath, backup: null }
  }

  let backup = null
  if (previousVersion !== null) {
    backup = `${scriptPath}.bak.${Date.now()}`
    copyFileSync(scriptPath, backup)
  }
  writeFileSync(scriptPath, templateContent)
  return {
    action: previousVersion === null ? 'installed' : 'upgraded',
    version: templateVersion,
    previousVersion,
    scriptPath,
    backup,
  }
}

export function bootstrapCursorHooks({
  hooksPath = defaultHooksJsonPath(),
  scriptPath = defaultHookScriptPath(),
  templatePath = defaultTemplatePath(),
  uninstallMarkerPath = defaultUninstallMarkerPath(),
  respectUninstallMarker = true,
} = {}) {
  if (respectUninstallMarker && existsSync(uninstallMarkerPath)) {
    return { skipped: true, reason: 'uninstall_marker', uninstallMarkerPath }
  }

  let markerCleared = false
  if (!respectUninstallMarker && existsSync(uninstallMarkerPath)) {
    try { unlinkSync(uninstallMarkerPath); markerCleared = true } catch { /* ignore */ }
  }

  const scriptResult = deployHookScript({ scriptPath, templatePath })

  const inspect = inspectHooks({ hooksPath, hookScriptPath: scriptPath })
  if (inspect.error === 'malformed_hooks_json') {
    return {
      skipped: true,
      reason: 'malformed_hooks_json',
      hooksPath,
      scriptResult,
      markerCleared,
    }
  }

  if (inspect.installed) {
    return {
      skipped: false,
      alreadyInstalled: true,
      scriptResult,
      hookResult: null,
      markerCleared,
    }
  }

  const hookResult = installHooks({
    hooksPath,
    hookScriptPath: scriptPath,
    uninstallMarkerPath,
    clearUninstallMarker: false,
  })
  return {
    skipped: false,
    alreadyInstalled: false,
    scriptResult,
    hookResult,
    markerCleared,
  }
}

export const __test__ = {
  buildHookEntry,
  MANAGED_KEY,
  HOOK_EVENTS,
  SCHEMA_VERSION,
  parseHookVersion,
  eventToArg,
  defaultTemplatePath,
  defaultUninstallMarkerPath,
}
