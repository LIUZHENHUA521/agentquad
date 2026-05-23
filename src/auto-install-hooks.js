// Auto-install / upgrade AgentQuad's claude + codex hooks on server bootstrap.
// Failures must NOT break server startup — log + return a status, let the
// existing /api/status `hookOutdated` flag surface manual-reinstall banner as fallback.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  bootstrapHooks as bootstrapClaudeHooks,
  installHooks as installClaudeHooks,
  getInstalledHookVersion,
  EXPECTED_HOOK_VERSION,
  HOOK_EVENTS as CLAUDE_HOOK_EVENTS,
} from './openclaw-hook-installer.js'

import {
  bootstrapCodexHooks,
  installHooks as installCodexHooks,
} from './codex-hook-installer.js'

/**
 * Try to auto-install/upgrade hooks for both tools. Returns a status object
 * the caller can log. NEVER throws.
 *
 * @param {object} opts
 * @param {object} opts.config       - loaded config (needs config.localSessions.autoInstallHooks)
 * @param {object} [opts.logger]     - pino-compatible logger (info/warn); falls back to console
 * @param {string} [opts.homeDir]    - override homedir (for tests)
 */
export function maybeAutoInstallHooks({ config, logger = console, homeDir = homedir() } = {}) {
  const result = { claude: 'skipped', codex: 'skipped' }

  // Only skip if explicitly false; undefined / missing → treat as true (default)
  if (config?.localSessions?.autoInstallHooks === false) {
    return result
  }

  // ── Claude ──────────────────────────────────────────────────────────────────
  try {
    const claudeHome = join(homeDir, '.claude')
    if (!existsSync(claudeHome)) {
      result.claude = 'no-claude-dir'
    } else {
      // 始终调用 bootstrap：它内部 deployHookScript 会按 quadtodo-hook-version 自动判断
      // 是否需要覆盖 notify.js，install 部分也对 settings.json 幂等。这样 notify.js
      // 脚本版本升级（独立于 settings.json 的 EXPECTED_HOOK_VERSION）也能被检测到。
      // 仅当 settings.json 版本过旧（< EXPECTED_HOOK_VERSION）时才强制忽略
      // .uninstalled marker，避免在脚本版本升级时清掉用户显式 opt-out。
      const settingsVer = getInstalledHookVersion()
      const forceInstall = settingsVer != null && settingsVer < EXPECTED_HOOK_VERSION
      const bootstrapResult = bootstrapClaudeHooks({ respectUninstallMarker: !forceInstall })
      if (bootstrapResult.skipped) {
        result.claude = `skipped: ${bootstrapResult.reason}`
      } else if (
        bootstrapResult.alreadyInstalled &&
        bootstrapResult.scriptResult?.action === 'unchanged'
      ) {
        result.claude = 'up-to-date'
      } else {
        const scriptAction = bootstrapResult.scriptResult?.action
        result.claude = scriptAction === 'upgraded'
          ? `script ${bootstrapResult.scriptResult.previousVersion}→${bootstrapResult.scriptResult.version}`
          : settingsVer == null ? 'installed' : 'refreshed'
        logger?.info?.({
          scriptAction,
          settingsVer,
          expected: EXPECTED_HOOK_VERSION,
        }, '[auto-install] claude hooks updated')
      }
    }
  } catch (e) {
    result.claude = `failed: ${e?.message || e}`
    logger?.warn?.({ err: e?.message }, '[auto-install] claude hooks install failed; fallback to banner')
  }

  // ── Codex ───────────────────────────────────────────────────────────────────
  try {
    const codexHome = join(homeDir, '.codex')
    if (!existsSync(codexHome)) {
      result.codex = 'no-codex-dir'
    } else {
      // bootstrapCodexHooks is idempotent: deploys script (version-gated) and
      // merges hook entries. Respects .uninstalled marker by default.
      const bootstrapResult = bootstrapCodexHooks()
      if (bootstrapResult.skipped) {
        result.codex = `skipped: ${bootstrapResult.reason}`
      } else if (bootstrapResult.alreadyInstalled && bootstrapResult.scriptResult?.action === 'unchanged') {
        result.codex = 'up-to-date'
      } else {
        result.codex = 'installed'
        logger?.info?.({}, '[auto-install] codex hooks installed/refreshed')
      }
    }
  } catch (e) {
    result.codex = `failed: ${e?.message || e}`
    logger?.warn?.({ err: e?.message }, '[auto-install] codex hooks install failed; fallback to banner')
  }

  return result
}
