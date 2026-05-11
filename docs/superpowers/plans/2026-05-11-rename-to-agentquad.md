# Rename quadtodo → AgentQuad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand `quadtodo` to `AgentQuad`: rename npm package, CLI bin (with `quadtodo` alias kept), data directory `~/.quadtodo/` → `~/.agentquad/` (auto-migrated), and all user-facing strings — without breaking existing users.

**Architecture:** Migration logic lives in a single helper `migrateLegacyHomeDirIfNeeded()` in `src/config.js`, called explicitly from `src/cli.js` at startup (so tests with explicit `rootDir` don't trigger it). All other changes are mechanical sweeps across docs/src/web with grep-verifiable post-conditions.

**Tech Stack:** Node 20+, vitest, commander, no new dependencies.

---

## Task 1: Failing migration tests (RED)

**Files:**
- Create: `test/rename-migration.test.js`

- [ ] **Step 1: Write the failing test file**

```js
// test/rename-migration.test.js
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('migrateLegacyHomeDirIfNeeded', () => {
  let home
  let stderrBuf
  const stderr = { write: (s) => { stderrBuf += s } }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentquad-test-'))
    stderrBuf = ''
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('migrates legacy dir to new dir and writes marker', async () => {
    const oldDir = join(home, '.quadtodo')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'x')
    writeFileSync(join(oldDir, 'config.json'), JSON.stringify({ wiki: { wikiDir: join(home, '.quadtodo', 'wiki') } }))

    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })

    expect(result.action).toBe('migrated')
    expect(existsSync(join(home, '.agentquad', 'data.db'))).toBe(true)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(home, '.agentquad', '.migrated-from-quadtodo'))).toBe(true)
    const cfg = JSON.parse(readFileSync(join(home, '.agentquad', 'config.json'), 'utf8'))
    expect(cfg.wiki.wikiDir).toBe(join(home, '.agentquad', 'wiki'))
    expect(stderrBuf).toMatch(/migrated/i)
  })

  it('is a no-op when new dir already exists', async () => {
    mkdirSync(join(home, '.agentquad'), { recursive: true })
    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })
    expect(result.action).toBe('skip')
    expect(result.reason).toBe('new-exists')
  })

  it('emits hint when both old and new dirs exist', async () => {
    mkdirSync(join(home, '.agentquad'), { recursive: true })
    mkdirSync(join(home, '.quadtodo'), { recursive: true })
    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })
    expect(result.action).toBe('skip')
    expect(stderrBuf).toMatch(/legacy.*ignoring/i)
    expect(existsSync(join(home, '.quadtodo'))).toBe(true)
  })

  it('aborts when legacy service is still running', async () => {
    const oldDir = join(home, '.quadtodo')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'data.db'), 'x')
    writeFileSync(join(oldDir, 'quadtodo.pid'), '12345')

    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => true })

    expect(result.action).toBe('abort')
    expect(result.reason).toBe('pid-alive')
    expect(existsSync(join(home, '.agentquad'))).toBe(false)
    expect(existsSync(oldDir)).toBe(true)
    expect(stderrBuf).toMatch(/running quadtodo service/i)
  })

  it('does no migration when no legacy dir exists', async () => {
    const { migrateLegacyHomeDirIfNeeded } = await import('../src/config.js')
    const result = migrateLegacyHomeDirIfNeeded({ home, stderr, isPidAlive: () => false })
    expect(result.action).toBe('skip')
    expect(result.reason).toBe('no-legacy')
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run test/rename-migration.test.js
```

Expected: FAIL with `migrateLegacyHomeDirIfNeeded is not a function` (or similar) on every case.

- [ ] **Step 3: Commit**

```bash
git add test/rename-migration.test.js
git commit -m "test(rename): add failing tests for legacy dir migration helper"
```

---

## Task 2: Implement migration helper + update resolveDefaultRootDir (GREEN)

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Add helper imports at the top of `src/config.js`**

In the existing `node:fs` import (line 3-11), add `rmSync` and `cpSync`. Replace the import block with:

```js
import {
	accessSync,
	constants,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
```

- [ ] **Step 2: Replace `resolveDefaultRootDir` with the dual-home version**

Replace `src/config.js` lines 25-33 (`function resolveDefaultRootDir() { ... }`) with:

```js
function resolveDefaultRootDir() {
	const envRootDir = process.env.AGENTQUAD_ROOT_DIR || process.env.QUADTODO_ROOT_DIR;
	if (envRootDir) return resolvePath(envRootDir);

	const newHomeDir = join(homedir(), ".agentquad");
	if (canUseRootDir(newHomeDir)) return newHomeDir;

	const legacyHomeDir = join(homedir(), ".quadtodo");
	if (existsSync(legacyHomeDir) && canUseRootDir(legacyHomeDir)) return legacyHomeDir;

	const newCwdDir = resolvePath(process.cwd(), ".agentquad");
	if (canUseRootDir(newCwdDir)) return newCwdDir;

	return resolvePath(process.cwd(), ".quadtodo");
}
```

- [ ] **Step 3: Update the wiki default to use the new dir name**

In `defaultConfig()` (around line 309), change:

```js
wikiDir: join(homedir(), ".quadtodo", "wiki"),
```

to:

```js
wikiDir: join(homedir(), ".agentquad", "wiki"),
```

- [ ] **Step 4: Append the `migrateLegacyHomeDirIfNeeded` helper**

Add this at the end of `src/config.js` (after `setConfigValue`):

```js
function defaultIsPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function rewriteConfigPaths(configPath, oldHome, newHome) {
	if (!existsSync(configPath)) return;
	try {
		const raw = readFileSync(configPath, "utf8");
		const rewritten = raw.split(oldHome).join(newHome);
		if (rewritten !== raw) writeFileSync(configPath, rewritten);
	} catch {
		// Non-fatal: caller will surface the abnormal config on next normalize.
	}
}

function moveDirectory(src, dest) {
	try {
		renameSync(src, dest);
		return;
	} catch (err) {
		if (err && err.code !== "EXDEV") throw err;
	}
	cpSync(src, dest, { recursive: true });
	rmSync(src, { recursive: true, force: true });
}

export function migrateLegacyHomeDirIfNeeded({
	home = homedir(),
	stderr = process.stderr,
	isPidAlive = defaultIsPidAlive,
} = {}) {
	const newDir = join(home, ".agentquad");
	const oldDir = join(home, ".quadtodo");

	if (existsSync(newDir)) {
		if (existsSync(oldDir)) {
			stderr.write(
				`AgentQuad: found legacy ~/.quadtodo/ alongside ~/.agentquad/; ignoring. Delete it manually when ready.\n`,
			);
		}
		return { action: "skip", reason: "new-exists" };
	}
	if (!existsSync(oldDir)) {
		return { action: "skip", reason: "no-legacy" };
	}

	const legacyPidFile = join(oldDir, "quadtodo.pid");
	if (existsSync(legacyPidFile)) {
		const pid = Number.parseInt(
			(readFileSync(legacyPidFile, "utf8") || "").trim(),
			10,
		);
		if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
			stderr.write(
				`AgentQuad: detected running quadtodo service (pid ${pid}).\n`,
			);
			stderr.write(
				`Please run \`quadtodo stop\` (or kill ${pid}) and start AgentQuad again.\n`,
			);
			return { action: "abort", reason: "pid-alive", pid };
		}
	}

	moveDirectory(oldDir, newDir);

	rewriteConfigPaths(join(newDir, "config.json"), oldDir, newDir);

	const stalePid = join(newDir, "quadtodo.pid");
	if (existsSync(stalePid)) rmSync(stalePid, { force: true });

	const oldLog = join(newDir, "logs", "quadtodo.log");
	const newLog = join(newDir, "logs", "agentquad.log");
	if (existsSync(oldLog) && !existsSync(newLog)) {
		try {
			renameSync(oldLog, newLog);
		} catch {
			// Non-fatal.
		}
	}

	writeFileSync(
		join(newDir, ".migrated-from-quadtodo"),
		new Date().toISOString(),
	);
	stderr.write(`AgentQuad: migrated ~/.quadtodo → ~/.agentquad\n`);
	return { action: "migrated" };
}
```

- [ ] **Step 5: Run migration tests — must pass**

```bash
npx vitest run test/rename-migration.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 6: Run the rest of the config test file — must still pass**

```bash
npx vitest run test/config.test.js
```

Expected: PASS (the change to `resolveDefaultRootDir` is upward-compatible; explicit `rootDir` callers are unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/config.js
git commit -m "feat(rename): migrate ~/.quadtodo to ~/.agentquad with PID-alive guard"
```

---

## Task 3: Wire migration into CLI startup + rename internal file names

**Files:**
- Modify: `src/cli.js`

- [ ] **Step 1: Import migration helper**

In `src/cli.js`, update the import block (lines 8-15) to:

```js
import {
  DEFAULT_ROOT_DIR,
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  resolveToolsConfig,
  migrateLegacyHomeDirIfNeeded,
} from './config.js'
```

- [ ] **Step 2: Call migration before any data access**

Immediately after the imports and `__filename`/`__dirname` definitions (after line 18), insert:

```js
// Run legacy-dir migration once per CLI invocation, before any config read.
// Aborts the process if a legacy quadtodo service is still running.
{
  const result = migrateLegacyHomeDirIfNeeded()
  if (result.action === 'abort') process.exit(1)
}
```

- [ ] **Step 3: Rename `pidFile` to use `agentquad.pid`**

Change the `pidFile` function (line 42-44) to:

```js
function pidFile(rootDir = DEFAULT_ROOT_DIR) {
  return join(rootDir, 'agentquad.pid')
}
```

- [ ] **Step 4: Rename log file from `quadtodo.log` to `agentquad.log`**

Find the line `const logFile = join(logsDir, 'quadtodo.log')` (around line 345). Change to:

```js
const logFile = join(logsDir, 'agentquad.log')
```

And update the adjacent log-line marker (around line 358):

```js
logStream.write(`\n=== agentquad start ${new Date().toISOString()} pid=${process.pid} ===\n`)
```

- [ ] **Step 5: Change commander program name**

Find `.name('quadtodo')` (around line 322). Change to:

```js
.name('agentquad')
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run test/cli.test.js test/rename-migration.test.js
```

Expected: PASS. If `test/cli.test.js` asserts on the old `quadtodo.pid` filename or `program.name`, note the failure — fix it in Task 10 (this task intentionally leaves test/cli.test.js to the test sweep).

- [ ] **Step 7: Commit**

```bash
git add src/cli.js
git commit -m "feat(rename): wire migration into CLI startup and rename pid/log files"
```

---

## Task 4: package.json + web/package.json identity update

**Files:**
- Modify: `package.json`
- Modify: `web/package.json`

- [ ] **Step 1: Update root `package.json` identity fields**

In `package.json`, change:

```json
"name": "quadtodo",
"version": "0.1.1",
"description": "Local four-quadrant todo CLI with embedded Claude Code / Codex terminal",
```

to:

```json
"name": "agentquad",
"version": "0.2.0",
"description": "AgentQuad — local four-quadrant AI task scheduler with embedded Claude Code / Codex terminals",
```

Change the `keywords` array to:

```json
"keywords": [
  "cli",
  "agent",
  "agentquad",
  "todo",
  "quadrant",
  "claude-code",
  "codex",
  "terminal"
]
```

Change the `bin` object from:

```json
"bin": {
  "quadtodo": "src/cli.js"
}
```

to:

```json
"bin": {
  "agentquad": "src/cli.js",
  "quadtodo": "src/cli.js"
}
```

Change `repository.url`, `homepage`, `bugs.url` to point at `agentquad`:

```json
"repository": {
  "type": "git",
  "url": "git+ssh://git@github.com/LIUZHENHUA521/agentquad.git"
},
"homepage": "https://github.com/LIUZHENHUA521/agentquad#readme",
"bugs": {
  "url": "https://github.com/LIUZHENHUA521/agentquad/issues"
}
```

- [ ] **Step 2: Update `web/package.json` name**

Change `web/package.json`'s `name` field to `"agentquad-web"`.

- [ ] **Step 3: Regenerate lockfiles (just root + web)**

```bash
npm install --package-lock-only
cd web && npm install --package-lock-only && cd ..
```

Expected: `package-lock.json` and `web/package-lock.json` updated with new `name`/`version`. No new packages downloaded.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json web/package.json web/package-lock.json
git commit -m "chore(rename): bump npm identity to agentquad@0.2.0 with quadtodo bin alias"
```

---

## Task 5: Route remaining `.quadtodo` path literals through helpers

**Files:**
- Modify: `src/openclaw-hook.js:38`
- Modify: `src/server.js:1144`
- Modify: `src/orchestrator.js:483`
- Modify: each file listed by the grep below

Goal: after this task, no `.quadtodo` directory literal remains in `src/` outside `src/config.js` (where it lives inside `migrateLegacyHomeDirIfNeeded` and `resolveDefaultRootDir`'s legacy fallback).

- [ ] **Step 1: Locate all remaining literals**

```bash
grep -rn '\.quadtodo' src/ scripts/ --include='*.js' | grep -v 'config.js' | grep -v migrate
```

Record the list. Every match needs one of two fixes:
- (a) If the literal builds an absolute path, replace with `DEFAULT_ROOT_DIR` (or `import.meta` of an existing helper that resolves to it).
- (b) If the literal is a *comment* describing where files live, update the path to `~/.agentquad/` (or rephrase to "the AgentQuad data directory").

- [ ] **Step 2: Fix `src/openclaw-hook.js`**

Replace literal at line 38:

```js
const TRANSCRIPT_TMP_DIR = join(homedir(), '.quadtodo', 'tmp')
```

with (also update the import block to add `DEFAULT_ROOT_DIR`):

```js
import { DEFAULT_ROOT_DIR } from './config.js'
const TRANSCRIPT_TMP_DIR = join(DEFAULT_ROOT_DIR, 'tmp')
```

Update the comment on line 4 from `~/.quadtodo/claude-hooks/notify.js` to `~/.agentquad/claude-hooks/notify.js`.

- [ ] **Step 3: Fix `src/server.js:1144`**

Replace:

```js
wikiDir: join(process.env.HOME || process.cwd(), ".quadtodo", "wiki"),
```

with:

```js
wikiDir: join(DEFAULT_ROOT_DIR, "wiki"),
```

Confirm `DEFAULT_ROOT_DIR` is already imported in `src/server.js`; if not, add it to the existing `./config.js` import statement.

- [ ] **Step 4: Leave `.quadtodo-worktrees` directory name alone**

The literal `.quadtodo-worktrees` at `src/orchestrator.js:483` is a runtime worktree-pool directory, **not** the data dir. Renaming it would orphan in-flight pipeline worktrees on upgrade. Keep it as-is for this rebrand. Add a code comment noting the deliberate keep:

```js
// NOTE: legacy worktree pool name kept after rebrand to avoid orphaning in-flight worktrees on upgrade.
const mine = all.filter(w => w.path.includes(`/.quadtodo-worktrees/${runId}/`))
```

Same approach for any other `quadtodo-worktrees` literal: keep, add a one-line "// legacy worktree pool name" comment once per file.

- [ ] **Step 5: Sweep the remaining files from Step 1's list**

For each file/line in the Step 1 grep output not handled above (e.g. `src/codex-sidecar.js`, `src/lark-image.js`, `src/telegram-image.js`, `src/routes/openclaw-hook.js`, `src/templates/claude-hooks/notify.js`, etc.), apply the same rule: comments → `~/.agentquad/...`; code literals → `DEFAULT_ROOT_DIR`.

- [ ] **Step 6: Verify no stray literals remain**

```bash
grep -rn '\.quadtodo' src/ scripts/ --include='*.js' | grep -v 'config.js'
```

Expected: empty output.

- [ ] **Step 7: Run server-touching tests**

```bash
npx vitest run test/server.test.js test/openclaw-hook.test.js test/openclaw-hook-installer.test.js test/codex-sidecar.test.js
```

Expected: PASS (any failures will likely be in Task 10 — tests asserting on old paths).

- [ ] **Step 8: Commit**

```bash
git add src/ scripts/
git commit -m "refactor(rename): route data-dir paths through DEFAULT_ROOT_DIR"
```

---

## Task 6: Sweep user-facing `quadtodo` strings in src/ and scripts/

**Files:**
- Modify: all `src/*.js` and `scripts/*.js` with user-facing `quadtodo` strings

Goal: messages printed to stderr/stdout and help text use `agentquad` (CLI command) and `AgentQuad` (brand name). Internal symbols (variable names like `quadtodoSessionId`) stay — they're not user-visible.

- [ ] **Step 1: List user-facing string occurrences**

```bash
grep -rn "quadtodo" src/ scripts/ --include='*.js' \
  | grep -vE "(quadtodoSessionId|QUADTODO_|quadtodo-worktrees)" \
  | grep -vE "^[^:]+:[0-9]+:\s*//"
```

Read each match; classify as:
- (a) printed string (`console.log`, `lines.push`, error messages) → replace literal `quadtodo` → `agentquad` (when it's a CLI verb like `\`quadtodo X\``) or `AgentQuad` (when it's a brand mention)
- (b) JSDoc or in-string comment → update path/name to match new naming
- (c) symbol name / config key / env var → **leave alone** unless it's `QUADTODO_*` env consumed only by the project (out of scope; alias support already in config.js)

- [ ] **Step 2: Apply replacements in `src/cli.js`**

Replace the strings in `buildStartupBanner` and `doctor` output. Examples:

`lines.push(`quadtodo listening on ${url('127.0.0.1')}  (loopback only)`)` →
`lines.push(`AgentQuad listening on ${url('127.0.0.1')}  (loopback only)`)`

`'     quadtodo config set host 0.0.0.0'` → `'     agentquad config set host 0.0.0.0'`

`'     quadtodo start --expose'` → `'     agentquad start --expose'`

`'⚠️  SECURITY: quadtodo exposes a shell + AI terminal. Reachable URLs:'` → `'⚠️  SECURITY: AgentQuad exposes a shell + AI terminal. Reachable URLs:'`

`'missing ${distIndex} — run \`npm run build\` (from source) or \`npm i -g quadtodo\` (reinstall)'` → `'missing ${distIndex} — run \`npm run build\` (from source) or \`npm i -g agentquad\` (reinstall)'`

Continue through all matches in `src/cli.js`. The doctor messages around lines 240, 286, 296, 299, 306 reference `quadtodo` CLI commands and the `~/.quadtodo/config.json` path — fix all.

- [ ] **Step 3: Apply replacements in the rest of `src/**` and `scripts/**`**

Walk the remaining files from Step 1. Typical sites:
- `src/telegram-bot.js`, `src/lark-bot.js` — bot help/start messages
- `src/openclaw-hook-installer.js` — wizard prompts
- `src/wiki/guide.js` — guide text
- `scripts/setup-telegram-commands.js` — command descriptions registered with Telegram

Treat each replacement as: brand-name → `AgentQuad`, CLI-verb → `agentquad`, path → `~/.agentquad/...`.

- [ ] **Step 4: Verify cleanup**

```bash
grep -rn "quadtodo" src/ scripts/ --include='*.js' \
  | grep -vE "(quadtodoSessionId|QUADTODO_|quadtodo-worktrees|migrate|migrated-from-quadtodo|\.quadtodo|legacy)" \
  | grep -vE "^[^:]+:[0-9]+:\s*//"
```

Remaining lines should be limited to:
- the migration helper messages (`"AgentQuad: migrated ~/.quadtodo → ~/.agentquad"` etc.)
- legacy-aware code (`QUADTODO_ROOT_DIR` env, `quadtodo.pid` legacy file detection)

If unexpected lines remain, fix them before committing.

- [ ] **Step 5: Run full test suite (expect a few failures from tests still asserting old strings)**

```bash
npx vitest run
```

Expected: most tests still pass; failures are confined to tests that assert exact output strings (will be handled in Task 10).

- [ ] **Step 6: Commit**

```bash
git add src/ scripts/
git commit -m "refactor(rename): replace user-facing quadtodo strings with AgentQuad/agentquad"
```

---

## Task 7: Rename `'quadtodo'` source-tag to `'agentquad'`

**Files:**
- Modify: `src/lark-config-service.js`
- Modify: `src/server.js` (telegram source emission)
- Modify: `web/src/SettingsDrawer.tsx`

Context: `botTokenSource` / `appSecretSource` API fields use a string-literal tag `'quadtodo'` to mean "the value comes from the AgentQuad config file." Rename to `'agentquad'` so the wire/UI stay consistent.

- [ ] **Step 1: Update server emission in `src/lark-config-service.js`**

Find:

```js
return secret && typeof secret === 'string' ? 'quadtodo' : 'missing'
```

Change `'quadtodo'` → `'agentquad'`.

- [ ] **Step 2: Update telegram source in `src/server.js`**

```bash
grep -n "'quadtodo'" src/server.js
```

For each result, swap the literal `'quadtodo'` → `'agentquad'` in the source-tag context (NOT in unrelated strings — read each match).

- [ ] **Step 3: Update web type definitions and render in `web/src/SettingsDrawer.tsx`**

Replace every `'quadtodo' | 'missing' | 'input'` type union (and the 2-arm variant `'quadtodo' | 'missing'`) with `'agentquad' | 'missing' | 'input'` / `'agentquad' | 'missing'`.

Inside `telegramSourceLabel` and `larkSourceLabel`:

```ts
if (source === 'quadtodo') return 'quadtodo'
```

becomes:

```ts
if (source === 'agentquad') return 'AgentQuad'
```

In the JSX tag renderers, replace:

```tsx
{tokenSource === 'quadtodo' && '来自 quadtodo 配置'}
```

with:

```tsx
{tokenSource === 'agentquad' && '来自 AgentQuad 配置'}
```

Same for `larkSecretSource`.

- [ ] **Step 4: Verify no stray `'quadtodo'` literals remain in web/src**

```bash
grep -n "'quadtodo'" web/src/ -r
```

Expected: empty.

- [ ] **Step 5: Run the lark/telegram tests + web build**

```bash
npx vitest run test/lark-bot.test.js test/telegram-config.route.test.js test/settings-drawer-lark-config.test.js
cd web && npx tsc --noEmit && cd ..
```

Expected: vitest PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/ web/src/
git commit -m "refactor(rename): rename source-tag 'quadtodo' to 'agentquad'"
```

---

## Task 8: Update web UI brand strings

**Files:**
- Modify: `web/index.html`
- Modify: `web/src/SettingsDrawer.tsx` (remaining brand strings not covered in Task 7)
- Modify: `web/src/AiTerminalMini.tsx`, `web/src/TranscriptView.tsx`, `web/src/replyHub.ts`, `web/src/pipeline/PipelineRunDrawer.tsx`, `web/src/api.ts`

- [ ] **Step 1: Update HTML title**

In `web/index.html`, change:

```html
<title>quadtodo</title>
```

to:

```html
<title>AgentQuad</title>
```

- [ ] **Step 2: Update brand strings in SettingsDrawer**

Sites in `web/src/SettingsDrawer.tsx`:
- Line 527: `extra="端口会保存到配置文件，重启 quadtodo 后生效。"` → `"端口会保存到配置文件，重启 AgentQuad 后生效。"`
- Line 725: `className="quadtodo-setup-guide"` → `className="agentquad-setup-guide"` (and update any CSS rule referencing it under `web/src/`)
- Line 988: `"关闭后只能从 quadtodo 推送到 Lark ..."` → `"关闭后只能从 AgentQuad 推送到 Lark ..."`
- Line 1156: `title="quadtodo 设置"` → `title="AgentQuad 设置"`
- Line 1201: `配置文件位置：<Text code>~/.quadtodo/config.json</Text>` → `~/.agentquad/config.json`

Local-storage key on lines 104 & 514: `'quadtodo.editor'` is a *user-local persisted key*. Two options:
- **Keep `'quadtodo.editor'`** (no migration needed, preserves user setting across rebrand)
- Rename to `'agentquad.editor'`, write a one-line read-then-migrate in `useEffect`

Choose **keep `'quadtodo.editor'`** for minimal risk; add a `// rebrand: localStorage key kept for backward compatibility` comment above the line.

- [ ] **Step 3: Sweep other web/src files**

```bash
grep -rn "quadtodo" web/src/ --include='*.ts' --include='*.tsx'
```

For each match, classify as brand mention (replace with `AgentQuad`) or path display (replace with `agentquad`/`~/.agentquad/`). Skip the deliberately kept localStorage key.

- [ ] **Step 4: Verify**

```bash
grep -rn "quadtodo" web/src/ --include='*.ts' --include='*.tsx' | grep -v "localStorage" | grep -v "quadtodo.editor"
```

Expected: empty (or only the deliberate-keep comment).

- [ ] **Step 5: Type-check and build the web bundle**

```bash
cd web && npx tsc --noEmit && npm run build && cd ..
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/
git commit -m "refactor(rename): web UI brand strings → AgentQuad"
```

---

## Task 8.5: Update MCP server name and OpenClaw installer paths

**Files:**
- Modify: MCP server entry (locate via grep)
- Modify: `src/openclaw-hook-installer.js`
- Modify: `src/cli.js` (doctor: warn on legacy openclaw skill folder)

These touch user-installed integrations (Claude Code `mcpServers`, OpenClaw skills dir). The implementation work is in-tree; users repair their integrations with documented post-install commands (Task 9's Upgrade section).

- [ ] **Step 1: Find the MCP server announced name**

```bash
grep -rn "name.*['\"]quadtodo['\"]" src/mcp/ src/server.js
grep -rn "new Server\|McpServer" src/ --include='*.js' | head
```

Locate the place where the MCP `Server`/`McpServer` is constructed with a `name` (per `@modelcontextprotocol/sdk`). Change that `name` field from `'quadtodo'` to `'agentquad'`. Record the file:line.

- [ ] **Step 2: Update MCP installer to clean stale `quadtodo` mcpServers entry**

```bash
grep -rn "mcpServers" src/ --include='*.js'
```

Locate the `mcp install` implementation that writes `~/.claude/settings.json`. Before writing the new `agentquad` entry, if a `quadtodo` entry exists whose `command` field resolves to the same package bin (i.e. installed by us), delete it. Pattern:

```js
const settings = readJSON(settingsPath)
const mcpServers = settings.mcpServers || {}
const legacy = mcpServers.quadtodo
if (legacy && typeof legacy.command === 'string' && /\/agentquad\/|\/quadtodo\//.test(legacy.command)) {
  delete mcpServers.quadtodo
}
mcpServers.agentquad = { /* new entry */ }
settings.mcpServers = mcpServers
writeJSON(settingsPath, settings)
```

Show a one-line stdout: `removed legacy mcpServers["quadtodo"] entry`.

- [ ] **Step 3: Rename OpenClaw skill folder writes**

In `src/openclaw-hook-installer.js`:

```bash
grep -n "quadtodo-claw\|quadtodo" src/openclaw-hook-installer.js
```

Change every `quadtodo-claw` path literal to `agentquad-claw`. The wizard now writes to `~/.openclaw/skills/agentquad-claw/`.

- [ ] **Step 4: Doctor warning for legacy openclaw skill folder**

In `src/cli.js`, locate the doctor check that asserts the openclaw skill is installed (around line 244-249). After the new-path check, add a soft warning if the legacy path still exists:

```js
const legacySkillFile = join(homedir(), '.openclaw', 'skills', 'quadtodo-claw', 'SKILL.md')
if (existsSync(legacySkillFile)) {
  results.push({
    name: 'legacy openclaw skill folder',
    ok: true,
    detail: 'legacy ~/.openclaw/skills/quadtodo-claw/ still exists — safe to delete',
    severity: 'warn',
  })
}
```

Match the existing `results.push({...})` shape in `src/cli.js`; if it's slightly different in your branch, adapt the keys.

- [ ] **Step 5: Run the openclaw + mcp tests**

```bash
npx vitest run test/openclaw-hook-installer.test.js test/openclaw-wizard.test.js test/openclaw-bridge.test.js test/openclaw-hook.codex.test.js test/mcp.read.test.js test/mcp.write.test.js test/mcp.destructive.test.js
```

Expected: pass, possibly with some failures in tests asserting old MCP name `'quadtodo'` — fix those in lockstep (the test sweep in Task 10 will catch any leftover).

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "refactor(rename): MCP server name and OpenClaw installer paths"
```

---

## Task 9: Update README.md and docs/*.md

**Files:**
- Modify: `README.md`
- Modify: `docs/MCP.md`, `docs/OPENCLAW.md`, `docs/RELEASE.md`, `docs/TELEGRAM.md`, `docs/TELEGRAM-setup.md`, `docs/MOBILE.md`, `docs/LARK.md`
- Modify: root `debug-*.md` if they contain brand mentions

- [ ] **Step 1: Update README header and tagline**

Replace lines 1-3 of `README.md`:

```markdown
# quadtodo

本地四象限待办 CLI，每条 todo 可内嵌一个 Claude Code 或 Codex 终端会话。单 Node 进程自包含，不依赖云服务。
```

with:

```markdown
# AgentQuad

四象限里的 AI 调度台 —— 每个待办都能跑一个 Claude/Codex 会话，全本地。

> 原名 `quadtodo`。`quadtodo` 命令保留为 CLI alias，老脚本不受影响。
```

Update `GitHub 仓库：` line to point at `agentquad`.

- [ ] **Step 2: Update install/run examples in README.md**

Find every code block / inline command using `quadtodo` and change CLI-verb usage to `agentquad`:

- `npm install -g quadtodo` → `npm install -g agentquad`
- `quadtodo install-tools --all` → `agentquad install-tools --all`
- `quadtodo doctor`, `quadtodo start`, `quadtodo stop`, `quadtodo status`, `quadtodo config ...`, `quadtodo mcp install`, `quadtodo mcp status`, `quadtodo openclaw ...`, `quadtodo telegram:setup-menu`

Update the data-storage section to:

```
~/.agentquad/
├── config.json
├── data.db
├── agentquad.pid
└── logs/
    └── ai-*.log
```

Update the migration example near the bottom of the README:

```bash
scp -r ~/.agentquad target-host:~/
```

Append an **Upgrade** section near the top (after the 30-second quick-start):

```markdown
## 从 quadtodo 升级

```bash
npm uninstall -g quadtodo        # 卸掉老包，避免 bin 冲突
npm install -g agentquad         # 装新包，自带 `agentquad` + `quadtodo` 两个命令
agentquad start                  # 第一次启动会自动把 ~/.quadtodo/ 迁移到 ~/.agentquad/
```

- MCP 用户：跑 `agentquad mcp install` 把 `~/.claude/settings.json` 里的旧条目刷成新条目。
- OpenClaw 用户：旧 skill 目录 `~/.openclaw/skills/quadtodo-claw/` 不再使用；跑 `agentquad openclaw install-hook` 写入新目录。
- Telegram 用户：跑 `agentquad telegram:setup-menu` 刷新命令菜单。
```

- [ ] **Step 3: Sweep `docs/*.md`**

For each file in `docs/`:

```bash
grep -n "quadtodo" docs/<file>.md
```

Replace per the rule: brand mention → `AgentQuad`; CLI command → `agentquad`; path → `~/.agentquad/`. Re-read each doc after the sweep to catch grammar drift (e.g. "the agentquad CLI" awkward — should usually be "the AgentQuad CLI").

- [ ] **Step 4: Sweep root `debug-*.md`**

```bash
grep -ln "quadtodo" debug-*.md 2>/dev/null
```

Update brand mentions; leave verbatim user-input transcripts unchanged if they reference the old name.

- [ ] **Step 5: Verify**

```bash
grep -rn "\\bquadtodo\\b" README.md docs/ debug-*.md 2>/dev/null \
  | grep -vE "(quadtodo command|quadtodo alias|legacy|从 quadtodo|原名|quadtodo@|npm uninstall -g quadtodo)"
```

Expected: empty (only the deliberate "from quadtodo" / "legacy quadtodo" mentions remain).

- [ ] **Step 6: Commit**

```bash
git add README.md docs/ debug-*.md
git commit -m "docs(rename): switch all user-facing docs to AgentQuad"
```

---

## Task 10: Update existing tests and verify the whole suite

**Files:**
- Modify: `test/cli.test.js`, `test/config.test.js`, `test/server.test.js`, `test/server.config-mask.test.js`, and any other test files containing `quadtodo`

- [ ] **Step 1: List tests that reference `quadtodo`**

```bash
grep -ln "quadtodo" test/ -r
```

Classify each match:
- (a) test asserts on an output string that was changed → update expected value
- (b) test refers to a tmpdir name like `quadtodo-XXXX` → may stay or rename for clarity; not load-bearing
- (c) test creates a fake `~/.quadtodo` path → keep if it's *exercising* the legacy path (e.g. migration test); update otherwise
- (d) test imports `QUADTODO_ROOT_DIR` env → still works via the back-compat alias; update to `AGENTQUAD_ROOT_DIR` for new tests

- [ ] **Step 2: Update `test/cli.test.js`**

Find every `expect(...).toBe(...)` / `toContain(...)` that contains `quadtodo`. Replace with the new strings emitted in Tasks 3/6. Specifically:
- `pidFile` name: `quadtodo.pid` → `agentquad.pid`
- `program.name`: `quadtodo` → `agentquad`
- doctor output: `quadtodo listening on …` → `AgentQuad listening on …`

- [ ] **Step 3: Update `test/config.test.js` tmp-dir name**

For clarity, rename `mkdtempSync(join(tmpdir(), "quadtodo-"))` → `mkdtempSync(join(tmpdir(), "agentquad-"))`. This is cosmetic, but keeps tests aligned with the rebrand.

- [ ] **Step 4: Update server / route / mcp / openclaw / telegram / lark / stats tests**

For each remaining failing test, read the assertion, find what the code now emits, update the expected value.

- [ ] **Step 5: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 6: Build the web bundle end-to-end**

```bash
npm run build
```

Expected: build succeeds; `dist-web/` regenerated.

- [ ] **Step 7: Manual smoke test (one terminal)**

```bash
node src/cli.js doctor
node src/cli.js start --port 5688 --no-open
```

In another terminal:

```bash
curl -s http://127.0.0.1:5688/api/todos | head
node src/cli.js stop
```

Expected:
- `doctor` shows `AgentQuad listening …` / `AgentQuad` branding in messages
- `start` creates `~/.agentquad/agentquad.pid` and `~/.agentquad/logs/agentquad.log`
- `/api/todos` returns the existing todos JSON (or `[]` on a fresh dir)
- `stop` cleanly removes the pid file

- [ ] **Step 8: Final commit**

```bash
git add test/
git commit -m "test(rename): align tests with AgentQuad branding"
```

---

## Post-merge (NOT in this PR — track separately)

- GitHub repo rename `LIUZHENHUA521/quadtodo` → `LIUZHENHUA521/agentquad` via repo settings
- Publish `agentquad@0.2.0` to npm: `npm publish --access public`
- Publish a final `quadtodo@0.1.2` whose README is a 5-line "moved to agentquad" pointer
- `npm deprecate quadtodo "Renamed to 'agentquad'. Install with: npm i -g agentquad"`
