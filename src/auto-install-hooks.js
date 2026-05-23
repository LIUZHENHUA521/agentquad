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
      const current = getInstalledHookVersion()
      if (current == null || current < EXPECTED_HOOK_VERSION) {
        // Version missing or stale: force a full deploy + re-install.
        // bootstrapClaudeHooks respects the .uninstalled marker by default.
        // We intentionally call it with respectUninstallMarker=false here so
        // that "version upgrade" always wins — if the user uninstalled an OLD
        // version and we have a newer one, we should still upgrade.
        // But to stay conservative and not override explicit user opt-out,
        // keep respectUninstallMarker=true for the "not installed at all" case,
        // and only force-install when upgrading from a known older version.
        const forceInstall = current != null && current < EXPECTED_HOOK_VERSION
        const bootstrapResult = bootstrapClaudeHooks({ respectUninstallMarker: !forceInstall })
        if (bootstrapResult.skipped) {
          result.claude = `skipped: ${bootstrapResult.reason}`
        } else {
          result.claude = current == null ? 'installed' : `upgraded ${current}→${EXPECTED_HOOK_VERSION}`
          logger?.info?.({ from: current, to: EXPECTED_HOOK_VERSION }, '[auto-install] claude hooks updated')
        }
      } else {
        result.claude = 'up-to-date'
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
