# Tool Binary Directory PATH Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an AI tool is launched from an absolute binary path, prepend that binary's directory to the spawned PTY process PATH so wrappers like `claude-w` can find sibling executables such as `claude`.

**Architecture:** Keep this behavior local to PTY spawning. Add one small helper in `src/pty.js` that derives the child process PATH from `toolCfg.bin` and `process.env.PATH`, then use it in the `ptyFactory` env. Cover the behavior with focused unit tests in `test/pty.test.js`.

**Tech Stack:** Node.js ESM, `node-pty` abstraction via `PtyManager`, Vitest.

---

## File Structure

- Modify `src/pty.js`: add a small PATH-building helper and use it when constructing the spawned PTY environment.
- Modify `test/pty.test.js`: add tests for absolute binary paths and command-name-only binary paths.

No UI change is needed because the existing `tools.<tool>.bin` setting already stores the absolute wrapper path.

---

### Task 1: Add failing tests for PATH derivation

**Files:**
- Modify: `test/pty.test.js:1-45`

- [ ] **Step 1: Add imports needed for path separator checks**

Change the import block at `test/pty.test.js:1-3` from:

```js
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PtyManager } from '../src/pty.js'
```

to:

```js
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { delimiter } from 'node:path'
import { PtyManager } from '../src/pty.js'
```

- [ ] **Step 2: Add test for absolute tool binary path**

Insert this test after the existing `start spawns a pty with tool binary + args` test in `test/pty.test.js`:

```js
  it('prepends absolute tool binary directory to child PATH', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({
      tools: {
        claude: { bin: '/opt/company/bin/claude-w', args: [] },
        codex: { bin: 'codex', args: [] },
      },
      ptyFactory: factory,
    })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    const pathParts = factory.created[0]._opts.env.PATH.split(delimiter)
    expect(pathParts[0]).toBe('/opt/company/bin')
    expect(pathParts.slice(1).join(delimiter)).toBe(process.env.PATH || '')
  })
```

- [ ] **Step 3: Add test for command-name-only binary path**

Insert this test immediately after the absolute-path test:

```js
  it('does not change child PATH for command-name tool binaries', () => {
    const factory = makeFakePty()
    const pm = new PtyManager({ tools: tools(), ptyFactory: factory })
    pm.start({ sessionId: 's1', tool: 'claude', prompt: null, cwd: '/tmp' })
    expect(factory.created[0]._opts.env.PATH).toBe(process.env.PATH)
  })
```

- [ ] **Step 4: Run the targeted tests and verify they fail**

Run:

```bash
npm test -- test/pty.test.js --runInBand
```

Expected before implementation: the new absolute-path test fails because `factory.created[0]._opts.env.PATH` does not start with `/opt/company/bin`.

---

### Task 2: Implement automatic PATH prepend in PTY spawning

**Files:**
- Modify: `src/pty.js:5-7`
- Modify: `src/pty.js:30-45`
- Modify: `src/pty.js:311-322`

- [ ] **Step 1: Import path helpers**

Change the `node:path` import in `src/pty.js` from:

```js
import { join } from 'node:path'
```

to:

```js
import { delimiter, dirname, isAbsolute, join } from 'node:path'
```

- [ ] **Step 2: Add a helper to derive child PATH**

Insert this helper after `buildPermissionArgs` in `src/pty.js`:

```js
function buildChildPath(toolBin, basePath = process.env.PATH || '') {
  if (!toolBin || !isAbsolute(toolBin)) return basePath
  const binDir = dirname(toolBin)
  const parts = basePath ? basePath.split(delimiter).filter(Boolean) : []
  return [binDir, ...parts.filter((part) => part !== binDir)].join(delimiter)
}
```

- [ ] **Step 3: Use the helper in PTY env construction**

In `src/pty.js`, change the `env` object passed to `this.ptyFactory` from:

```js
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
          ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
        },
```

to:

```js
        env: {
          ...process.env,
          PATH: buildChildPath(toolCfg.bin),
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
          ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
        },
```

This keeps the change scoped to spawned AI terminal processes and does not mutate the quadtodo server process environment.

- [ ] **Step 4: Run the targeted tests and verify they pass**

Run:

```bash
npm test -- test/pty.test.js --runInBand
```

Expected after implementation: all tests in `test/pty.test.js` pass, including the two new PATH tests.

---

### Task 3: Verify the original Claude wrapper scenario

**Files:**
- No code changes.

- [ ] **Step 1: Run a local reproduction command that mirrors the failing environment**

Run:

```bash
PATH="/Users/bytedance/Library/pnpm:/Users/bytedance/.nvm/versions/node/v20.20.2/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" node -e "const {spawnSync}=require('node:child_process'); const {delimiter,dirname}=require('node:path'); const bin='/Users/bytedance/.local/bin/claude-w'; const env={...process.env, PATH:[dirname(bin), ...(process.env.PATH || '').split(delimiter).filter(Boolean).filter(p=>p!==dirname(bin))].join(delimiter)}; const r=spawnSync(bin,['--model','gpt-5.5-2026-04-24','--version'],{encoding:'utf8',env}); console.log(JSON.stringify({status:r.status,error:r.error&&r.error.code,stdout:r.stdout,stderr:r.stderr}, null, 2));"
```

Expected: status `0` and stdout containing `Claude Code`.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: the test suite exits with status `0`.

- [ ] **Step 3: Do not commit unless explicitly requested**

The repository has existing untracked files. Leave changes uncommitted unless the user explicitly asks for a commit.

---

## Self-Review

- Spec coverage: The plan implements the selected approach: derive PATH from absolute `tools.<tool>.bin`, apply it only to child PTY processes, and leave command-name binaries unchanged.
- Placeholder scan: No TODO/TBD placeholders remain.
- Type consistency: The helper name `buildChildPath(toolBin, basePath)` is used consistently, and tests inspect the existing fake PTY `_opts.env.PATH` shape.
