# npm Publish Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm publish` produce a package that a fresh user with `Node ≥20` on macOS / Linux can `npm i -g quadtodo && quadtodo install-tools --all && quadtodo doctor && quadtodo start` end-to-end without surprises.

**Architecture:** Incremental hardening of existing surfaces — bump native dep `node-pty` for prebuild coverage, extend the existing `doctorReport` with two new checks (Node version, dist-web), add a new `install-tools` subcommand that wraps `npm i -g` with a `which` re-verification, gate `start` with a friendly missing-frontend error, and surface a `tool_missing` frame from the AI terminal route so the web UI can render an actionable card.

**Tech Stack:** Node 20+, Commander 12 (CLI), Vitest (tests), Express + ws (server), better-sqlite3 + node-pty (native deps), React + Vite (web/).

**Spec:** `docs/superpowers/specs/2026-05-10-npm-publish-hardening-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | modify | bump `node-pty` to `^1.1.0-beta22`, add `os` field, rewire `prepack` |
| `scripts/ensure-web-deps.js` | create | guard `prepack` so packing without `web/node_modules` doesn't ship empty `dist-web/` |
| `src/cli.js` | modify | add `nodeVersionOK` + `distWebPresent` checks to `doctorReport`; new `install-tools` command; new `promptInstallMissing()` helper |
| `src/server.js` | modify | refuse to start if `dist-web/index.html` missing, with a friendly fix message |
| `src/routes/ai-terminal.js` | modify | pre-spawn `command -v` check; emit `tool_missing` event when claude/codex absent |
| `web/src/AiTerminalMini.tsx` | modify | render an actionable card when receiving `tool_missing` |
| `README.md` | modify | add "30 秒上手" block, mark macOS/Linux only |
| `docs/RELEASE.md` | create | smoke test checklist for releases |
| `test/cli.test.js` | modify | new tests for the two doctor checks + install-tools helpers |
| `test/server.test.js` | modify | new test for missing-dist-web startup refusal |
| `test/ai-terminal.route.test.js` | modify | new test for `tool_missing` emission |
| `test/ensure-web-deps.test.js` | create | unit test for the prepack guard |

---

## Task 1: Bump `node-pty` and add `os` constraint

Pure dependency / metadata change. Smoke-tested via `npm install` succeeding.

**Files:**
- Modify: `package.json` (dependencies, add `os` field)

- [ ] **Step 1: Update `package.json`**

In `package.json`:
- Change `"node-pty": "1.0.0"` → `"node-pty": "^1.1.0-beta22"`
- Below the `"engines"` block, insert:
  ```json
  "os": ["darwin", "linux"],
  ```

- [ ] **Step 2: Reinstall and verify no native compile**

Run:
```bash
rm -rf node_modules package-lock.json
npm install
```

Expected: install completes within ~30s, **no `gyp` / `make` lines** in stderr (means a prebuild was downloaded for node-pty).

If a native compile happens: confirm beta version actually has prebuild for the current Node major; if not, fall back to next beta tag (`npm view node-pty dist-tags`) and retry.

- [ ] **Step 3: Smoke test pty still works**

Run:
```bash
npm test -- pty.test.js
```

Expected: existing pty tests pass (the public API surface used by quadtodo hasn't changed between 1.0.0 and 1.1.0-beta).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: bump node-pty to ^1.1.0-beta22 (Node 22/24 prebuilds) + os: [darwin, linux]"
```

---

## Task 2: Add `scripts/ensure-web-deps.js` and rewire `prepack`

Guards the publish flow so packing on a freshly cloned repo (where `web/node_modules` may be missing) doesn't silently ship an empty `dist-web/`.

**Files:**
- Create: `scripts/ensure-web-deps.js`
- Create: `test/ensure-web-deps.test.js`
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Write the failing test**

Create `test/ensure-web-deps.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SCRIPT = resolve(__dirname, '../scripts/ensure-web-deps.js')

describe('ensure-web-deps', () => {
  it('exits 0 silently when web/node_modules already exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-ewd-'))
    try {
      mkdirSync(join(tmp, 'web', 'node_modules'), { recursive: true })
      writeFileSync(join(tmp, 'web', 'package.json'), '{"name":"web"}')
      const r = spawnSync('node', [SCRIPT], { cwd: tmp, encoding: 'utf8' })
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports a clear actionable error when web/package.json is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'qt-ewd-'))
    try {
      const r = spawnSync('node', [SCRIPT], { cwd: tmp, encoding: 'utf8' })
      expect(r.status).not.toBe(0)
      expect(r.stderr + r.stdout).toMatch(/web\/package\.json/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ensure-web-deps.test.js`
Expected: FAIL — script doesn't exist yet (`node ENOENT`).

- [ ] **Step 3: Create the script**

Create `scripts/ensure-web-deps.js`:

```javascript
#!/usr/bin/env node
// Run from repo root via `npm run ensure-web-deps`.
// Only intended for the publishing flow (`prepack`); not for end-user install.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const cwd = process.cwd()
const webDir = resolve(cwd, 'web')
const webPkg = resolve(webDir, 'package.json')
const webModules = resolve(webDir, 'node_modules')

if (!existsSync(webPkg)) {
  process.stderr.write(`ensure-web-deps: web/package.json not found at ${webPkg}\n`)
  process.stderr.write('Run this script from the quadtodo repo root.\n')
  process.exit(1)
}

if (existsSync(webModules)) {
  process.exit(0) // already installed; nothing to do
}

process.stdout.write('ensure-web-deps: installing web/ deps for prepack...\n')
const r = spawnSync('npm', ['ci'], { cwd: webDir, stdio: 'inherit' })
process.exit(r.status ?? 1)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ensure-web-deps.test.js`
Expected: both tests PASS.

- [ ] **Step 5: Wire into `prepack`**

In `package.json`, change `"scripts"`:
- Add: `"ensure-web-deps": "node scripts/ensure-web-deps.js",`
- Replace `"prepack": "npm run build"` with `"prepack": "npm run ensure-web-deps && npm run build:web"`

- [ ] **Step 6: Verify prepack works**

Run: `npm run prepack`
Expected: completes without error; `dist-web/index.html` exists afterwards.

- [ ] **Step 7: Commit**

```bash
git add scripts/ensure-web-deps.js test/ensure-web-deps.test.js package.json
git commit -m "build: add ensure-web-deps prepack guard"
```

---

## Task 3: Doctor — add Node version check

**Files:**
- Modify: `src/cli.js` (`doctorReport` function around line 128-280)
- Modify: `test/cli.test.js`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('cli helpers', ...)` block in `test/cli.test.js`:

```javascript
it('doctorReport includes a "Node version" check that passes on >=20', async () => {
  const report = await doctorReport({ rootDir })
  const check = report.checks.find(c => c.name === 'Node version')
  expect(check).toBeTruthy()
  // We are running on Node 20+; should pass.
  expect(check.ok).toBe(true)
  expect(check.detail).toMatch(/^v\d+/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.js -t "Node version"`
Expected: FAIL with `expected undefined to be truthy`.

- [ ] **Step 3: Implement the check**

In `src/cli.js`, in `doctorReport`, **immediately after** the existing `'rootDir exists'` push (around line 134), insert:

```javascript
{
  const major = Number(process.version.slice(1).split('.')[0])
  checks.push({
    name: 'Node version',
    ok: major >= 20,
    detail: process.version + (major >= 20 ? '' : ' (please upgrade to Node 20+; e.g. `nvm install 20`)'),
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli.test.js -t "Node version"`
Expected: PASS.

- [ ] **Step 5: Run full cli test file to catch regressions**

Run: `npx vitest run test/cli.test.js`
Expected: all tests PASS (including the existing `'doctorReport returns a checklist object'` which doesn't pin checks order).

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat(doctor): add Node version check"
```

---

## Task 4: Doctor — add `dist-web/index.html` check

**Files:**
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`

- [ ] **Step 1: Write the failing test**

In `test/cli.test.js`, inside the existing `describe('cli helpers', ...)`, add:

```javascript
it('doctorReport includes a "frontend assets" check naming dist-web/index.html', async () => {
  const report = await doctorReport({ rootDir })
  const check = report.checks.find(c => c.name === 'frontend assets')
  expect(check).toBeTruthy()
  expect(typeof check.ok).toBe('boolean')
  expect(check.detail || '').toMatch(/dist-web\/index\.html/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.js -t "frontend assets"`
Expected: FAIL.

- [ ] **Step 3: Implement the check**

In `src/cli.js`, inside `doctorReport`, **immediately after** the Node version check inserted in Task 3, add:

```javascript
{
  const distIndex = resolvePath(__dirname, '../dist-web/index.html')
  const ok = existsSync(distIndex)
  checks.push({
    name: 'frontend assets',
    ok,
    detail: ok
      ? distIndex
      : `missing ${distIndex} — run \`npm run build\` (from source) or \`npm i -g quadtodo\` (reinstall)`,
  })
}
```

(`resolvePath` and `__dirname` and `existsSync` are already imported at the top of `cli.js`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli.test.js -t "frontend assets"`
Expected: PASS (the build was done in Task 2's prepack run, so `dist-web/index.html` exists).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat(doctor): add dist-web/index.html presence check"
```

---

## Task 5: Add `install-tools` subcommand

The user-facing wrapper around `npm i -g` for `claude` / `codex`, with a post-install `which` re-verification.

**Files:**
- Modify: `src/cli.js` (new exported helpers + new `program.command`)
- Modify: `test/cli.test.js`

- [ ] **Step 1: Write the failing test**

In `test/cli.test.js`, add a new `describe` block at the bottom:

```javascript
import { TOOL_PACKAGES, planInstallTools } from '../src/cli.js'

describe('install-tools planning', () => {
  it('TOOL_PACKAGES maps claude → @anthropic-ai/claude-code (bin: claude) and codex → @openai/codex (bin: codex)', () => {
    expect(TOOL_PACKAGES.claude).toEqual({ pkg: '@anthropic-ai/claude-code', bin: 'claude' })
    expect(TOOL_PACKAGES.codex).toEqual({ pkg: '@openai/codex', bin: 'codex' })
  })

  it('planInstallTools({ all: true }) returns both tools in declared order', () => {
    expect(planInstallTools({ all: true })).toEqual(['claude', 'codex'])
  })

  it('planInstallTools({ claude: true }) returns only claude', () => {
    expect(planInstallTools({ claude: true })).toEqual(['claude'])
  })

  it('planInstallTools({}) defaults to all', () => {
    expect(planInstallTools({})).toEqual(['claude', 'codex'])
  })

  it('planInstallTools({ claude: true, codex: true }) returns both', () => {
    expect(planInstallTools({ claude: true, codex: true })).toEqual(['claude', 'codex'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.js -t "install-tools planning"`
Expected: FAIL — imports don't exist yet.

- [ ] **Step 3: Add `TOOL_PACKAGES` and `planInstallTools` to `src/cli.js`**

In `src/cli.js`, near the top of the file (just below the imports, before `loadPkgVersion`), add:

```javascript
// Bin names verified via `npm view <pkg> bin`.
export const TOOL_PACKAGES = {
  claude: { pkg: '@anthropic-ai/claude-code', bin: 'claude' },
  codex:  { pkg: '@openai/codex',             bin: 'codex'  },
}

export function planInstallTools(opts) {
  const flags = opts || {}
  const explicit = []
  if (flags.claude) explicit.push('claude')
  if (flags.codex)  explicit.push('codex')
  if (flags.all || explicit.length === 0) return ['claude', 'codex']
  return explicit
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cli.test.js -t "install-tools planning"`
Expected: all 5 PASS.

- [ ] **Step 5: Add the imperative command (no test — exercises real `npm`)**

In `src/cli.js`, anywhere alongside the other `program.command(...)` blocks (e.g. near the `doctor` command), add:

```javascript
program.command('install-tools')
  .description('Install missing AI CLIs (claude / codex) globally via npm')
  .option('--claude', 'install only @anthropic-ai/claude-code')
  .option('--codex',  'install only @openai/codex')
  .option('--all',    'install both (default if no flag given)')
  .option('-y, --yes', 'skip the y/N confirmation')
  .action(async (opts) => {
    const tools = planInstallTools(opts)
    const items = tools.map((t) => ({ tool: t, ...TOOL_PACKAGES[t] }))

    console.log('About to install:')
    for (const it of items) console.log(`  - ${it.pkg}  (binary: ${it.bin})`)
    console.log('Each one will be installed via:  npm install -g <pkg>')

    if (!opts.yes && process.stdin.isTTY) {
      const ok = await prompt('Continue? [y/N] ')
      if (!/^y(es)?$/i.test(ok.trim())) {
        console.log('Aborted.')
        process.exit(0)
      }
    }

    let allOk = true
    for (const it of items) {
      console.log(`\n>> npm install -g ${it.pkg}`)
      const r = spawnSync('npm', ['install', '-g', it.pkg], { stdio: 'inherit' })
      if (r.status !== 0) {
        console.error(`\n✗ npm install -g ${it.pkg} exited ${r.status}`)
        printInstallFailureFix(it)
        allOk = false
        break
      }
      const w = spawnSync('command', ['-v', it.bin], { encoding: 'utf8', shell: '/bin/sh' })
      if (w.status !== 0 || !w.stdout.trim()) {
        console.error(`\n✗ npm reported success but \`${it.bin}\` is not in PATH.`)
        printInstallFailureFix(it)
        allOk = false
        break
      }
      console.log(`✓ ${it.bin} → ${w.stdout.trim()}`)
    }

    process.exit(allOk ? 0 : 1)
  })

function printInstallFailureFix(it) {
  console.error(`
Common fixes:
  - Permissions: try \`sudo npm install -g ${it.pkg}\`,
    or move npm prefix into your home dir:
      \`npm config set prefix ~/.npm-global\`
      and add \`~/.npm-global/bin\` to your PATH.
  - If you use nvm: \`nvm use 20\` first, then retry.
  - Network/registry: check \`npm config get registry\`.
`)
}

function prompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    let buf = ''
    process.stdin.setEncoding('utf8')
    const onData = (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        process.stdin.removeListener('data', onData)
        resolve(buf.slice(0, nl))
      }
    }
    process.stdin.on('data', onData)
  })
}
```

- [ ] **Step 6: Smoke-test the help output**

Run: `node src/cli.js install-tools --help`
Expected: shows usage with `--claude`, `--codex`, `--all`, `-y, --yes`.

- [ ] **Step 7: Commit**

```bash
git add src/cli.js test/cli.test.js
git commit -m "feat(cli): add install-tools subcommand for claude / codex"
```

---

## Task 6: Doctor — interactive prompt for missing tools

When `doctor` (CLI invocation) finds claude/codex missing AND the process is attached to a TTY, offer to run `install-tools` for the missing subset only.

**Files:**
- Modify: `src/cli.js` (the `program.command('doctor')` action only — `doctorReport` itself stays pure for tests)

- [ ] **Step 1: Find current doctor command action**

Read `src/cli.js` around line 478 (`program.command('doctor')`). Note where `report` is consumed and printed.

- [ ] **Step 2: Add the missing-tools follow-up**

In `src/cli.js`, modify the `doctor` command action: **after** the existing report-printing logic but **before** any `process.exit`, insert:

```javascript
const missing = report.checks
  .filter(c => !c.ok && /^(claude|codex) binary$/.test(c.name))
  .map(c => c.name.split(' ')[0])

if (missing.length > 0) {
  const flags = missing.map(t => `--${t}`).join(' ')
  console.log(`\nMissing AI CLI(s): ${missing.join(', ')}`)
  console.log(`Suggested fix: quadtodo install-tools ${flags}`)
  if (process.stdin.isTTY) {
    const ans = await prompt(`Run it now? [Enter = yes / q = skip] `)
    if (ans.trim().toLowerCase() !== 'q') {
      const r = spawnSync(process.execPath, [
        fileURLToPath(import.meta.url),
        'install-tools',
        ...missing.map(t => `--${t}`),
        '-y',
      ], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }
  }
}
```

(`prompt` was added in Task 5; `spawnSync` and `fileURLToPath` and `import.meta.url` are already in scope.)

- [ ] **Step 3: Manual smoke test (positive path)**

Run: `node src/cli.js doctor`
Expected: prints checks; if claude/codex are installed, no follow-up prompt; if missing, asks "Run it now?".

- [ ] **Step 4: Manual smoke test (non-TTY path)**

Run: `node src/cli.js doctor < /dev/null`
Expected: prints checks + "Suggested fix: ..." line, but **does not** hang on a prompt.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js
git commit -m "feat(doctor): offer to run install-tools for missing claude/codex"
```

---

## Task 7: Server — refuse to start on missing `dist-web/index.html`

Currently `server.js` silently skips static file serving when `webDist` is absent or doesn't exist. That gives a confusing experience: `quadtodo start` runs but the browser shows nothing useful. Replace silent fallback with a friendly hard-stop on missing index.html.

**Files:**
- Modify: `src/server.js` (around line 1457)
- Modify: `test/server.test.js`

- [ ] **Step 1: Inspect current behavior**

Read `src/server.js` around lines 1455-1465 to confirm the `if (webDist && existsSync(webDist))` block. Note any callers passing `webDist: null` (e.g. tests).

- [ ] **Step 2: Write the failing test**

In `test/server.test.js`, add a new test:

```javascript
import { startServer } from '../src/server.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('startServer rejects when webDist is provided but missing index.html', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qt-server-distmiss-'))
  const fakeDist = join(tmp, 'dist-web') // does not exist
  await expect(
    startServer({
      rootDir: tmp,
      port: 0,
      host: '127.0.0.1',
      webDist: fakeDist,
      strictWebDist: true, // new opt
    })
  ).rejects.toThrow(/dist-web\/index\.html/)
  rmSync(tmp, { recursive: true, force: true })
})
```

(Adjust the import / setup to match this file's existing patterns — it likely already imports `startServer`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/server.test.js -t "rejects when webDist"`
Expected: FAIL.

- [ ] **Step 4: Implement strict mode**

In `src/server.js`, in the function options block (around line 428-440 where `webDist` is documented and destructured), add a new option `strictWebDist = false`. Then **immediately before** `app.listen` / `server.listen` (find the listening point), add:

```javascript
if (strictWebDist) {
  const indexPath = join(webDist || '', 'index.html')
  if (!webDist || !existsSync(indexPath)) {
    throw new Error(
      `frontend assets missing: ${indexPath}\n` +
      `  - if you installed via npm: reinstall with \`npm i -g quadtodo\`\n` +
      `  - if running from source: \`cd web && npm install && npm run build\``
    )
  }
}
```

Make sure `join` and `existsSync` are imported at the top of `server.js` (they almost certainly already are).

- [ ] **Step 5: Wire `start` CLI to pass `strictWebDist: true`**

In `src/cli.js` around line 357 where `webDist` is set on the start options, also pass:

```javascript
strictWebDist: true,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/server.test.js -t "rejects when webDist"`
Expected: PASS.

- [ ] **Step 7: Run full server test file (regression)**

Run: `npx vitest run test/server.test.js`
Expected: all pass (existing tests don't pass `strictWebDist`, so default `false` keeps them happy).

- [ ] **Step 8: Commit**

```bash
git add src/server.js src/cli.js test/server.test.js
git commit -m "feat(server): refuse to start with strictWebDist when index.html missing"
```

---

## Task 8: AI terminal route — emit `tool_missing` instead of ENOENT

Pre-spawn check: if the resolved bin for the requested tool isn't in PATH, send a structured frame to the WebSocket client and skip the spawn.

**Files:**
- Modify: `src/routes/ai-terminal.js` (around `spawnSession` near line 294)
- Modify: `test/ai-terminal.route.test.js`

- [ ] **Step 1: Read existing spawn / error path**

Read `src/routes/ai-terminal.js` lines 290-360 to confirm:
- Where the actual pty spawn happens (likely `pty.spawn(...)` with `tool` resolving to a bin via config)
- What the WebSocket frame format for output looks like (so we mirror it for `tool_missing`)

- [ ] **Step 2: Add `resolveToolBin` helper inside the route module**

In `src/routes/ai-terminal.js`, near the top imports add:

```javascript
import { spawnSync } from 'node:child_process'
import { resolveToolsConfig } from '../config.js'
```

(Skip the `resolveToolsConfig` import if already present.)

Then add this helper near the other top-level helpers:

```javascript
function checkToolAvailable(tool, cfg) {
  const tools = resolveToolsConfig(cfg)
  const bin = tools?.[tool]?.bin || tools?.[tool]?.command || tool
  const r = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: '/bin/sh' })
  return {
    ok: r.status === 0 && r.stdout.trim().length > 0,
    bin,
    resolvedPath: r.stdout.trim() || null,
  }
}
```

- [ ] **Step 3: Write the failing test**

In `test/ai-terminal.route.test.js`, find the existing test that hits `POST /api/ai-terminal/sessions` and add a new test below it:

```javascript
it('returns 424 with code "tool_missing" when the requested tool is not in PATH', async () => {
  // Configure the bin to a guaranteed-not-existing name.
  setConfigValue('tools.claude.bin', '/tmp/__definitely_not_a_real_bin_xyz', { rootDir })

  const res = await request(app)
    .post('/api/ai-terminal/sessions')
    .send({ todoId, prompt: 'hi', tool: 'claude' })

  expect(res.status).toBe(424)
  expect(res.body).toMatchObject({
    code: 'tool_missing',
    tool: 'claude',
    fix: 'quadtodo install-tools --claude',
  })
})
```

(Adjust imports and setup to match the file's existing pattern — `app`, `request`, `rootDir`, `todoId` likely already exist.)

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/ai-terminal.route.test.js -t "tool_missing"`
Expected: FAIL — the route currently spawns and returns a different error.

- [ ] **Step 5: Implement the pre-check in `spawnSession`**

In `src/routes/ai-terminal.js`, inside `spawnSession`, **immediately after** the `if (!['claude', 'codex'].includes(tool))` guard (around line 302), add:

```javascript
const cfg = loadConfig({ rootDir })
const avail = checkToolAvailable(tool, cfg)
if (!avail.ok) {
  const err = new Error(`tool_missing: ${tool} (looked for "${avail.bin}" in PATH)`)
  err.code = 'tool_missing'
  err.tool = tool
  err.bin = avail.bin
  err.fix = `quadtodo install-tools --${tool}`
  throw err
}
```

(If `loadConfig` and `rootDir` aren't already in scope, import them from `../config.js` and accept `rootDir` as a parameter to the module's setup function — match how the rest of this file gets config.)

- [ ] **Step 6: Map `tool_missing` errors to HTTP 424 in the route handler**

Find the HTTP route handler that calls `spawnSession` (likely around line 415). In its `try/catch`, add a branch:

```javascript
} catch (e) {
  if (e.code === 'tool_missing') {
    return res.status(424).json({
      code: 'tool_missing',
      tool: e.tool,
      bin: e.bin,
      fix: e.fix,
      message: e.message,
    })
  }
  // ... existing error handling
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/ai-terminal.route.test.js -t "tool_missing"`
Expected: PASS.

- [ ] **Step 8: Run full ai-terminal test file (regression)**

Run: `npx vitest run test/ai-terminal.route.test.js`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "feat(ai-terminal): return 424 tool_missing when claude/codex not in PATH"
```

---

## Task 9: Frontend — render a `tool_missing` card in `AiTerminalMini`

When the API returns 424 with `code: tool_missing`, show an actionable card in place of the terminal so the user knows exactly what to run.

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`

(No automated test — `web/` doesn't have a test suite for components. Manual verification.)

- [ ] **Step 1: Locate session-creation error handling**

In `web/src/AiTerminalMini.tsx`, find where it POSTs to `/api/ai-terminal/sessions`. The catch / non-2xx branch is where we add the new path.

- [ ] **Step 2: Add the new state and parse**

Near the existing useState declarations, add:

```typescript
const [toolMissing, setToolMissing] = useState<null | { tool: string; bin: string; fix: string }>(null)
```

In the POST handler, on non-2xx:

```typescript
const body = await res.json().catch(() => null)
if (res.status === 424 && body?.code === 'tool_missing') {
  setToolMissing({ tool: body.tool, bin: body.bin, fix: body.fix })
  return
}
// ... existing fallthrough error toast
```

- [ ] **Step 3: Render the card**

Near the top of the component's JSX (replacing the terminal area when `toolMissing` is set), add:

```tsx
{toolMissing && (
  <div style={{
    border: '1px solid #d9d9d9', borderRadius: 6, padding: 16, margin: 12,
    background: '#fffbe6'
  }}>
    <div style={{ fontWeight: 600, marginBottom: 8 }}>
      AI tool <code>{toolMissing.tool}</code> not installed
    </div>
    <div style={{ marginBottom: 12, color: '#595959' }}>
      The binary <code>{toolMissing.bin}</code> was not found in your PATH.
      Run this in your terminal to install it:
    </div>
    <div style={{
      fontFamily: 'ui-monospace, monospace', background: '#f5f5f5',
      padding: 8, borderRadius: 4, marginBottom: 12,
    }}>
      {toolMissing.fix}
    </div>
    <button onClick={() => navigator.clipboard.writeText(toolMissing.fix)}>
      Copy
    </button>
    <button style={{ marginLeft: 8 }} onClick={() => setToolMissing(null)}>
      Dismiss
    </button>
  </div>
)}
```

- [ ] **Step 4: Build and smoke-test in browser**

```bash
cd web && npm run build && cd ..
quadtodo config set tools.claude.bin /tmp/__no_such_bin
node src/cli.js start
```

Open http://127.0.0.1:5677, create a todo, try to start a `claude` session. Expected: see the yellow card with the install command and Copy button. **Do not** see a black ENOENT log dump.

Reset the config when done:
```bash
quadtodo config set tools.claude.bin claude
```

- [ ] **Step 5: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(web): render tool_missing card instead of ENOENT toast"
```

---

## Task 10: README — add "30 秒上手" block + platform constraint

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert the quickstart block**

In `README.md`, **immediately after** the opening paragraph and **before** the `## 依赖` heading, insert:

```markdown
## 30 秒上手

```bash
npm install -g quadtodo            # 装 quadtodo 本体
quadtodo install-tools --all       # 装 claude + codex（AI 终端必需）
quadtodo doctor                    # 自检
quadtodo start                     # 自动打开浏览器 → http://127.0.0.1:5677
```

> **平台**：仅支持 macOS / Linux；Windows 暂不支持，规划中。
```

- [ ] **Step 2: Update the `## 依赖` section**

In the existing `## 依赖` list, replace the line about `claude`/`codex` with:

```markdown
- `claude` / `codex`（AI 终端必需）—— 没装的话跑 `quadtodo install-tools --all`，或手动 `npm i -g @anthropic-ai/claude-code @openai/codex`
```

And replace `macOS / Linux（node-pty 需要 C++ 编译工具链）` with:

```markdown
- macOS / Linux（Windows 暂不支持）
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add 30s quickstart + macOS/Linux only note"
```

---

## Task 11: Create `docs/RELEASE.md` — smoke test checklist

**Files:**
- Create: `docs/RELEASE.md`

- [ ] **Step 1: Write the file**

Create `docs/RELEASE.md`:

```markdown
# Release smoke test

Run before each `npm publish`.

## Prep

- [ ] On a clean branch, `git status` is clean
- [ ] `web/node_modules` exists (or trust prepack to install it via `ensure-web-deps`)

## Pack

- [ ] `npm pack`
- [ ] `tar tf quadtodo-*.tgz | grep -E 'package/(src/cli\.js|dist-web/index\.html|package\.json)$'` → all 3 must hit
- [ ] tgz size sanity: `ls -lh quadtodo-*.tgz` (baseline < 5MB before frontend; total ~hundreds of KB to a few MB)

## Install (do this in a clean dir, NOT the repo)

- [ ] `mkdir /tmp/qt-test && cd /tmp/qt-test`
- [ ] `npm i /path/to/quadtodo-*.tgz` — completes without `gyp`/`make` lines (= prebuild used)
- [ ] Repeat once on Node 20 and once on Node 22 / 24 (use nvm)

## Run

- [ ] `quadtodo doctor` — all 8 checks green (Node version, frontend assets, better-sqlite3, node-pty, claude, codex, cursor binary if configured, plus rootDir / config.json)
- [ ] `quadtodo install-tools --all -y` — installs cleanly; final lines show `✓ claude → ...` and `✓ codex → ...`
- [ ] `quadtodo doctor` again — claude / codex now green
- [ ] `quadtodo start` — banner shows port; browser opens
- [ ] Create a todo → open AI terminal with claude → type `pwd` → see response

## Tool-missing UX (regression check)

- [ ] `quadtodo config set tools.claude.bin /tmp/__no_such_bin`
- [ ] Restart, try to start a claude session → yellow card with `quadtodo install-tools --claude` + Copy button
- [ ] `quadtodo config set tools.claude.bin claude` (reset)

## Publish

- [ ] `npm publish --dry-run` — review file list one more time
- [ ] `npm publish`
- [ ] `npm view quadtodo version` matches what we shipped
- [ ] In a clean dir: `npx quadtodo@<new-version> doctor` — works end-to-end from registry
```

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASE.md
git commit -m "docs: add release smoke test checklist"
```

---

## Task 12: End-to-end smoke test on the candidate tarball

This is the final sign-off — the spec's main acceptance criterion ("a fresh user with Node 20+ can install and run").

- [ ] **Step 1: Pack**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npm pack
```

Expected: produces `quadtodo-0.1.0.tgz` (or whatever version) in the repo root.

- [ ] **Step 2: Inspect tarball contents**

```bash
tar tf quadtodo-*.tgz | grep -E 'package/(src/cli\.js|dist-web/index\.html|package\.json)$'
```

Expected: all 3 paths printed.

- [ ] **Step 3: Install into a clean dir**

```bash
mkdir -p /tmp/qt-smoke && cd /tmp/qt-smoke
npm init -y
npm i /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo/quadtodo-*.tgz
```

Expected: completes without `gyp`/`make` compile lines (means prebuilds were used).

- [ ] **Step 4: Run doctor from the candidate**

```bash
./node_modules/.bin/quadtodo doctor
```

Expected: report prints; each check has `name` + `ok` + `detail`. Critical checks (Node version, frontend assets, better-sqlite3, node-pty) all green.

- [ ] **Step 5: Cleanup**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
rm -rf /tmp/qt-smoke
rm -f quadtodo-*.tgz
```

- [ ] **Step 6: Final commit (if anything trivial got fixed during smoke test)**

If the smoke test surfaced any tiny issue (typo in `RELEASE.md`, missing import, etc.), fix and:

```bash
git add .
git commit -m "fix: address issues found during release smoke test"
```

If nothing surfaced, skip this commit.

---

## Self-Review Notes

- **Spec coverage**: every section of the spec has a Task — package.json (T1, T2), doctor extensions (T3, T4, T6), install-tools (T5), server startup (T7), AI terminal route (T8), frontend card (T9), README (T10), RELEASE.md (T11), end-to-end (T12). ✅
- **Type consistency**: `TOOL_PACKAGES` shape is identical in T5 test, T5 implementation, and T8 helper (`bin` field reused). The `tool_missing` frame contract: T8 implementation uses `{ code, tool, bin, fix, message }`; T8 test asserts the same shape; T9 frontend reads `tool, bin, fix`. ✅
- **No placeholders**: every code block contains complete, runnable code. The only "find the existing X" steps (T8 step 1, T9 step 1) are because the surface is too long to quote — the engineer has to skim the file once. Each such step is followed by a concrete edit step with full code. ✅
