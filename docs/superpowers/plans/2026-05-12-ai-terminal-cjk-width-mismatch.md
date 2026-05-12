# AI Terminal CJK Width Mismatch Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix web-embedded AI terminal layout corruption (em-dash overflow, label overlap, status bar fragmentation) caused by Claude/Codex measuring East Asian Ambiguous chars as 2 cells while xterm.js renders them as 1 cell.

**Architecture:** Two-pronged fix.
1. **Backend** (`src/pty.js`): inject `LANG`/`LC_CTYPE=en_US.UTF-8` on PTY child env so wcwidth aligns with xterm.js (Unicode 6 / ambiguous=narrow). Pure function `resolvePtyLocaleEnv()` is unit-tested in isolation; an env override `AGENTQUAD_KEEP_CJK_LOCALE=1` preserves the legacy behavior for users who need it.
2. **Frontend** (`web/src/AiTerminalMini.tsx`): load `@xterm/addon-unicode11` and switch `term.unicode.activeVersion = '11'` as a baseline upgrade and partial defense for tools that bake in their own width tables.

**Tech Stack:** Node 20+, vitest, node-pty 1.1.0-beta22, @xterm/xterm 5.5.0, @xterm/addon-unicode11 0.8.0.

**Spec:** `docs/superpowers/specs/2026-05-12-ai-terminal-cjk-width-mismatch-design.md`

---

## File Map

- **Create** `test/pty.localeEnv.test.js` — vitest unit tests for `resolvePtyLocaleEnv()`.
- **Create** `test/pty.spawnEnv.test.js` — integration test asserting `PtyManager.create()` passes resolved env to `ptyFactory`.
- **Modify** `src/pty.js` — add exported `resolvePtyLocaleEnv()`; wire it into both env construction sites (`create()` around line 482 and `startShell()` around line 724).
- **Modify** `web/package.json` — add `@xterm/addon-unicode11` dependency.
- **Modify** `web/src/AiTerminalMini.tsx` — import `Unicode11Addon`, load it during `Terminal` init, set `activeVersion = '11'`.
- **Modify** `README.md` — add troubleshooting section documenting `AGENTQUAD_KEEP_CJK_LOCALE`.

---

## Task 1: Pure-function `resolvePtyLocaleEnv()` (TDD)

**Files:**
- Create: `test/pty.localeEnv.test.js`
- Modify: `src/pty.js` (add new exported function near the top, after the imports block)

- [ ] **Step 1.1: Write the failing tests**

Create `test/pty.localeEnv.test.js` with full content:

```js
import { describe, it, expect } from 'vitest'
import { resolvePtyLocaleEnv } from '../src/pty.js'

describe('resolvePtyLocaleEnv', () => {
  it('injects en_US.UTF-8 fallback when LANG/LC_CTYPE absent', () => {
    expect(resolvePtyLocaleEnv({})).toEqual({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    })
  })

  it('overrides zh_CN.UTF-8 (CJK) with en_US.UTF-8', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' })).toEqual({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    })
  })

  it('overrides ja_JP.UTF-8 (CJK) with en_US.UTF-8', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'ja_JP.UTF-8' })).toEqual({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    })
  })

  it('overrides ko_KR.UTF-8 (CJK) with en_US.UTF-8', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'ko_KR.UTF-8', LC_CTYPE: 'ko_KR.UTF-8' })).toEqual({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    })
  })

  it('preserves user choice when both LANG and LC_CTYPE are already non-CJK UTF-8', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' })).toEqual({})
  })

  it('preserves de_DE.UTF-8 (non-CJK UTF-8)', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'de_DE.UTF-8', LC_CTYPE: 'de_DE.UTF-8' })).toEqual({})
  })

  it('overrides POSIX/C (non-UTF-8) with en_US.UTF-8 fallback', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'POSIX', LC_CTYPE: 'C' })).toEqual({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    })
  })

  it('escape hatch: AGENTQUAD_KEEP_CJK_LOCALE=1 returns {} even with CJK LANG', () => {
    expect(
      resolvePtyLocaleEnv({ AGENTQUAD_KEEP_CJK_LOCALE: '1', LANG: 'zh_CN.UTF-8', LC_CTYPE: 'zh_CN.UTF-8' })
    ).toEqual({})
  })

  it('escape hatch does NOT trigger on AGENTQUAD_KEEP_CJK_LOCALE=0 or other values', () => {
    expect(
      resolvePtyLocaleEnv({ AGENTQUAD_KEEP_CJK_LOCALE: '0', LANG: 'zh_CN.UTF-8' })
    ).toEqual({ LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' })
  })

  it('mixed: CJK LANG + non-CJK LC_CTYPE → still overrides both (LC_CTYPE alone is not enough to trust the env)', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'zh_CN.UTF-8', LC_CTYPE: 'en_US.UTF-8' })).toEqual({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
    })
  })

  it('case-insensitive UTF-8 detection: utf8, UTF8, utf-8 all count', () => {
    expect(resolvePtyLocaleEnv({ LANG: 'en_US.utf8', LC_CTYPE: 'en_US.UTF8' })).toEqual({})
  })
})
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npx vitest run test/pty.localeEnv.test.js`

Expected: all 11 tests FAIL with `SyntaxError`/`ReferenceError`/"resolvePtyLocaleEnv is not a function" (or similar — the function does not exist yet).

- [ ] **Step 1.3: Add the function to `src/pty.js`**

Insert this block in `src/pty.js` right before the `function defaultPtyFactory()` declaration (which currently lives around line 192):

```js
/**
 * Returns env overrides to inject into PTY children so that wcwidth aligns
 * with xterm.js. xterm.js (Unicode 6 default) treats East Asian Ambiguous
 * chars (em-dash, ellipsis, several box-drawing chars) as 1 cell; CJK
 * locales make wcwidth return 2. The disagreement breaks Claude/Codex TUI
 * layout in the web terminal even though local Terminal.app renders fine.
 *
 * Rules:
 *  - AGENTQUAD_KEEP_CJK_LOCALE=1 → return {} (user opted out)
 *  - Both LANG and LC_CTYPE already non-CJK UTF-8 → return {} (respect user)
 *  - Otherwise force LANG + LC_CTYPE to en_US.UTF-8. LC_ALL is intentionally
 *    NOT set so user's LC_TIME/LC_MESSAGES/etc. survive.
 */
export function resolvePtyLocaleEnv(procEnv = process.env) {
  if (procEnv.AGENTQUAD_KEEP_CJK_LOCALE === '1') return {}

  const isNonCjkUtf8 = (val) => {
    if (!val) return false
    if (!/utf-?8/i.test(val)) return false
    if (/^(zh|ja|ko)[_.-]/i.test(val)) return false
    return true
  }

  if (isNonCjkUtf8(procEnv.LANG) && isNonCjkUtf8(procEnv.LC_CTYPE)) return {}

  return {
    LANG: isNonCjkUtf8(procEnv.LANG) ? procEnv.LANG : 'en_US.UTF-8',
    LC_CTYPE: isNonCjkUtf8(procEnv.LC_CTYPE) ? procEnv.LC_CTYPE : 'en_US.UTF-8',
  }
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `npx vitest run test/pty.localeEnv.test.js`

Expected: all 11 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add test/pty.localeEnv.test.js src/pty.js
git commit -m "$(cat <<'EOF'
feat(pty): add resolvePtyLocaleEnv helper for CJK width alignment

Pure function returning LANG/LC_CTYPE overrides for PTY children, so
wcwidth on the child side agrees with xterm.js's Unicode 6 narrow-ambiguous
width for em-dash / box-drawing chars. Respects existing non-CJK UTF-8
env and an AGENTQUAD_KEEP_CJK_LOCALE=1 escape hatch. Not yet wired into
spawn — that's Task 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire `resolvePtyLocaleEnv()` into PTY spawn (TDD)

**Files:**
- Create: `test/pty.spawnEnv.test.js`
- Modify: `src/pty.js` (env block in `create()` ~L482; env block in `startShell()` ~L724)

- [ ] **Step 2.1: Write the failing integration test**

Create `test/pty.spawnEnv.test.js` with full content:

```js
import { describe, it, expect, vi } from 'vitest'
import { PtyManager } from '../src/pty.js'

function makeFakePtyFactory(captured) {
  return (bin, args, opts) => {
    captured.bin = bin
    captured.args = args
    captured.opts = opts
    // Minimal fake pty proc that satisfies the surface PtyManager touches:
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  }
}

function makeTools() {
  return {
    claude: { bin: 'echo', args: [], envExtra: {} },
  }
}

describe('PtyManager env injection', () => {
  it('passes en_US.UTF-8 LANG/LC_CTYPE to ptyFactory when parent process has zh_CN.UTF-8', () => {
    const captured = {}
    const mgr = new PtyManager({
      tools: makeTools(),
      ptyFactory: makeFakePtyFactory(captured),
      // Bypass session locator file IO — we don't care here.
      claudeSessionLocator: () => null,
      codexSessionLocator: () => null,
    })

    // Stub process.env for just this test.
    const origLang = process.env.LANG
    const origLcCtype = process.env.LC_CTYPE
    const origKeep = process.env.AGENTQUAD_KEEP_CJK_LOCALE
    process.env.LANG = 'zh_CN.UTF-8'
    process.env.LC_CTYPE = 'zh_CN.UTF-8'
    delete process.env.AGENTQUAD_KEEP_CJK_LOCALE

    try {
      mgr.create({ sessionId: 's1', tool: 'claude', prompt: null, cwd: process.cwd() })
      mgr.startWithSize('s1', 120, 40)
    } finally {
      if (origLang === undefined) delete process.env.LANG
      else process.env.LANG = origLang
      if (origLcCtype === undefined) delete process.env.LC_CTYPE
      else process.env.LC_CTYPE = origLcCtype
      if (origKeep === undefined) delete process.env.AGENTQUAD_KEEP_CJK_LOCALE
      else process.env.AGENTQUAD_KEEP_CJK_LOCALE = origKeep
    }

    expect(captured.opts.env.LANG).toBe('en_US.UTF-8')
    expect(captured.opts.env.LC_CTYPE).toBe('en_US.UTF-8')
  })

  it('keeps CJK LANG when AGENTQUAD_KEEP_CJK_LOCALE=1', () => {
    const captured = {}
    const mgr = new PtyManager({
      tools: makeTools(),
      ptyFactory: makeFakePtyFactory(captured),
      claudeSessionLocator: () => null,
      codexSessionLocator: () => null,
    })

    const origLang = process.env.LANG
    const origKeep = process.env.AGENTQUAD_KEEP_CJK_LOCALE
    process.env.LANG = 'zh_CN.UTF-8'
    process.env.AGENTQUAD_KEEP_CJK_LOCALE = '1'

    try {
      mgr.create({ sessionId: 's2', tool: 'claude', prompt: null, cwd: process.cwd() })
      mgr.startWithSize('s2', 120, 40)
    } finally {
      if (origLang === undefined) delete process.env.LANG
      else process.env.LANG = origLang
      if (origKeep === undefined) delete process.env.AGENTQUAD_KEEP_CJK_LOCALE
      else process.env.AGENTQUAD_KEEP_CJK_LOCALE = origKeep
    }

    expect(captured.opts.env.LANG).toBe('zh_CN.UTF-8')
  })

  it('extraEnv from caller wins over locale injection (caller intent preserved)', () => {
    const captured = {}
    const mgr = new PtyManager({
      tools: makeTools(),
      ptyFactory: makeFakePtyFactory(captured),
      claudeSessionLocator: () => null,
      codexSessionLocator: () => null,
    })

    const origLang = process.env.LANG
    process.env.LANG = 'zh_CN.UTF-8'

    try {
      mgr.create({
        sessionId: 's3',
        tool: 'claude',
        prompt: null,
        cwd: process.cwd(),
        extraEnv: { LANG: 'fr_FR.UTF-8' },
      })
      mgr.startWithSize('s3', 120, 40)
    } finally {
      if (origLang === undefined) delete process.env.LANG
      else process.env.LANG = origLang
    }

    expect(captured.opts.env.LANG).toBe('fr_FR.UTF-8')
  })

  it('startShell also gets locale injection', () => {
    const captured = {}
    const mgr = new PtyManager({
      tools: makeTools(),
      ptyFactory: makeFakePtyFactory(captured),
      claudeSessionLocator: () => null,
      codexSessionLocator: () => null,
    })

    const origLang = process.env.LANG
    const origKeep = process.env.AGENTQUAD_KEEP_CJK_LOCALE
    process.env.LANG = 'zh_CN.UTF-8'
    delete process.env.AGENTQUAD_KEEP_CJK_LOCALE

    try {
      mgr.startShell({ sessionId: 'shell1', shell: '/bin/sh', cwd: process.cwd() })
    } finally {
      if (origLang === undefined) delete process.env.LANG
      else process.env.LANG = origLang
      if (origKeep === undefined) delete process.env.AGENTQUAD_KEEP_CJK_LOCALE
      else process.env.AGENTQUAD_KEEP_CJK_LOCALE = origKeep
    }

    expect(captured.opts.env.LANG).toBe('en_US.UTF-8')
    expect(captured.opts.env.LC_CTYPE).toBe('en_US.UTF-8')
  })
})
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `npx vitest run test/pty.spawnEnv.test.js`

Expected: tests FAIL. First/second/fourth fail because injection isn't wired yet — `captured.opts.env.LANG` will be `zh_CN.UTF-8` (inherited) instead of `en_US.UTF-8`. Third may also fail depending on current spread order.

- [ ] **Step 2.3: Wire `resolvePtyLocaleEnv()` into `create()`**

Find this block in `src/pty.js` (currently around line 482):

```js
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      TZ: process.env.TZ || 'America/Los_Angeles',
      FORCE_COLOR: '1',
      ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
    }
```

Replace with:

```js
    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      TZ: process.env.TZ || 'America/Los_Angeles',
      FORCE_COLOR: '1',
      ...resolvePtyLocaleEnv(process.env),
      ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
    }
```

Critical ordering: `resolvePtyLocaleEnv` spreads **after** `...process.env` (so it overrides inherited CJK LANG) but **before** `...extraEnv` (so callers with intentional locale via `extraEnv` still win).

- [ ] **Step 2.4: Wire `resolvePtyLocaleEnv()` into `startShell()`**

Find this block in `src/pty.js` (currently around line 724):

```js
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
        },
```

Replace with:

```js
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          TZ: process.env.TZ || 'America/Los_Angeles',
          FORCE_COLOR: '1',
          ...resolvePtyLocaleEnv(process.env),
        },
```

- [ ] **Step 2.5: Run all PTY tests to verify they pass and existing tests still pass**

Run: `npx vitest run test/pty`

Expected: all tests in `test/pty.*.test.js` (including the new `pty.localeEnv` and `pty.spawnEnv`) PASS. No regressions in `pty.test.js`, `pty.codex-spawn.test.js`, or `pty.findCodexSession.test.js`.

- [ ] **Step 2.6: Run the whole test suite**

Run: `npm test`

Expected: full vitest suite green.

- [ ] **Step 2.7: Commit**

```bash
git add test/pty.spawnEnv.test.js src/pty.js
git commit -m "$(cat <<'EOF'
feat(pty): inject non-CJK UTF-8 locale into spawned PTY children

PtyManager.create() and startShell() now spread resolvePtyLocaleEnv()
into the child env, overriding inherited zh_CN/ja/ko LANG/LC_CTYPE with
en_US.UTF-8 so wcwidth agrees with xterm.js on East Asian Ambiguous
character width. Caller-supplied extraEnv still wins.

Fixes: web terminal layout corruption (em-dash overflow, label/divider
overlap, Claude TUI status-bar fragmentation) when AgentQuad is launched
from a CJK locale shell.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Install and integrate `@xterm/addon-unicode11`

**Files:**
- Modify: `web/package.json` (add dependency)
- Modify: `web/package-lock.json` (auto-regenerated)
- Modify: `web/src/AiTerminalMini.tsx` (import, loadAddon, set activeVersion)

- [ ] **Step 3.1: Install the addon**

Run from repo root:

```bash
npm install --workspace=web @xterm/addon-unicode11@^0.8.0
```

Expected: `web/package.json` gains the dependency; `web/package-lock.json` updates. No peer dependency warnings (it's officially built against @xterm/xterm 5.x).

- [ ] **Step 3.2: Import and load the addon in `AiTerminalMini.tsx`**

In `web/src/AiTerminalMini.tsx`, add the import near the other addon imports (currently around lines 9-11):

```ts
import { Unicode11Addon } from '@xterm/addon-unicode11'
```

Then find the Terminal init block (currently around line 464-486) that looks like:

```ts
      const term = new Terminal({ ... })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      try { term.loadAddon(new CanvasAddon()) } catch { /* 老浏览器回退 DOM */ }
      // 永久隐藏 xterm cursor ...
      term.write('\x1b[?25l')
      termRef.current = term
      fitRef.current = fit
```

Insert the Unicode11 addon load **immediately after** `const term = new Terminal({...})` and **before** the FitAddon load. Final block:

```ts
      const term = new Terminal({
        fontSize: 13,
        fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        theme: themeRef.current,
        cursorBlink: false,
        convertEol: true,
        scrollback: 5000,
        disableStdin: false,
      })
      // Unicode 11 width tables — must load before any term.write so width
      // measurement for East Asian Ambiguous chars (em-dash, ellipsis,
      // certain box-drawing) matches what TUI authors target.
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      try { term.loadAddon(new CanvasAddon()) } catch { /* 老浏览器回退 DOM */ }
      term.write('\x1b[?25l')
      termRef.current = term
      fitRef.current = fit
```

(Keep the existing inline comments around `cursorBlink` and `永久隐藏 xterm cursor` — they're shown trimmed above only for brevity. Edit in place, don't replace.)

- [ ] **Step 3.3: Type-check + build the web bundle**

Run:

```bash
npm run -w web build
```

Expected: TypeScript passes (`tsc -b` no errors); `vite build` succeeds; final bundle size grows by < 50KB (addon-unicode11 is ~30KB minified).

- [ ] **Step 3.4: Smoke-check in dev mode (manual, optional but recommended)**

Run:

```bash
npm start
```

Open the web UI, start an AI session, and confirm:
- Terminal renders normally (no console errors about `term.unicode` undefined).
- Typing `printf '─────────\\n中文测试\\n'` in a shell session renders the line at the expected width.

If anything regresses, abort the commit and report.

- [ ] **Step 3.5: Commit**

```bash
git add web/package.json web/package-lock.json web/src/AiTerminalMini.tsx
git commit -m "$(cat <<'EOF'
feat(web): upgrade xterm to Unicode 11 width tables

Loads @xterm/addon-unicode11 and activates version '11' so width
measurement for East Asian Ambiguous chars and post-Unicode-6 codepoints
matches what modern TUIs target. Complements the PTY-side locale fix
for the AI terminal layout corruption issue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Document the escape hatch in README

**Files:**
- Modify: `README.md` (add a troubleshooting section)

- [ ] **Step 4.1: Locate the right section in README**

Open `README.md` and find an existing troubleshooting / FAQ section, OR — if none exists — pick a spot near the end before the License section. Add the following sub-section.

- [ ] **Step 4.2: Append the new sub-section**

Insert this content:

````markdown
### Web 终端排版错乱（横线 / 框线 / 中英文混排错位）

AgentQuad 默认会把 PTY 子进程的 `LANG` / `LC_CTYPE` 兜底为 `en_US.UTF-8`，以避免 CJK locale 下 wcwidth 把"东亚歧义宽度"字符（em-dash `—`、ellipsis `…`、部分框线字符）算成 2 列，而 web 端 xterm.js 按 1 列渲染，从而排版错位。

副作用：被启动的 CLI（claude / codex 等）输出里 CLI 自身的 UI 文案会变英文。你的对话内容（含中文）不受影响。

如需保留主进程的 CJK locale，设置环境变量后启动：

```bash
AGENTQUAD_KEEP_CJK_LOCALE=1 npm start
```

只对你显式给的 `LC_CTYPE` 和 `LANG` 都是 non-CJK UTF-8（例如已经 `export LANG=en_US.UTF-8`）的情况下，AgentQuad 不会再覆盖。
````

- [ ] **Step 4.3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): document AGENTQUAD_KEEP_CJK_LOCALE escape hatch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: End-to-end manual verification

**Files:** none modified — this task produces evidence for the PR description, not code.

- [ ] **Step 5.1: Verify before/after with a reproducible Claude prompt**

In one terminal:

```bash
export LANG=zh_CN.UTF-8
export LC_CTYPE=zh_CN.UTF-8
npm start
```

Open the web UI. Create a todo with the prompt:

> "用 markdown 画一个 2 列 4 行的表格，标题用中英混排：选项 / Description；分隔线用 em-dash 重复。然后下面写一段 200 字的中文说明。"

Take a screenshot of the rendered AI terminal output.

- [ ] **Step 5.2: Compare with local Terminal.app**

Open Terminal.app, run the same `claude` command manually with the same prompt. Take a screenshot.

Compare: column alignment of the table, em-dash separator length, no labels overlapping into the divider line, status bar at the bottom of the TUI is on its own line.

**Pass criteria:** web terminal output is visually equivalent to local Terminal.app for the same prompt (allowing minor differences in font glyph rendering, but no layout corruption).

- [ ] **Step 5.3: Verify escape hatch reproduces the old bug**

Stop AgentQuad. Restart with:

```bash
AGENTQUAD_KEEP_CJK_LOCALE=1 LANG=zh_CN.UTF-8 npm start
```

Run the same prompt. Confirm the layout corruption returns (em-dashes overflow, labels overlap). This proves the escape hatch genuinely bypasses the fix and that the locale injection is what's doing the work.

- [ ] **Step 5.4: Verify resize stability**

In the fixed run (no escape hatch), drag the browser window from wide (~1920px) down to narrow (~800px). Confirm:
- The TUI redraws cleanly each time
- Em-dash separators truncate at the right margin (no overflow)
- Nothing overlaps from the previous render

- [ ] **Step 5.5: Capture artifacts for PR description**

Save the three screenshots (before, after, escape-hatch reproduction) and the four bullet observations under a `## Manual verification` heading in the PR description. No code commit for this step.

---

## Self-Review Checklist

Done while writing this plan:

- **Spec coverage (§3 验收标准 → tasks):**
  - "分隔线 / 标签 / 表格视觉一致" → Task 5.1 + 5.2
  - "底部状态栏一行完整" → implicit in Task 5.2 visual comparison
  - "resize 链路无回归" → Task 5.4
  - "codex 长输出 replay 无错位" → covered by Task 5 manual flow (codex is interchangeable with claude as the TUI emitter; the fix is shared)
  - "AGENTQUAD_KEEP_CJK_LOCALE=1 生效" → Task 5.3
  - "npm run -w web build 通过" → Task 3.3
  - "npm test 通过" → Task 2.6
  - "新单测覆盖 resolvePtyLocaleEnv" → Task 1
  - "bundle 体积 < 50KB" → Task 3.3 expected output
- **Placeholder scan:** none. Every code step has full code; every command has expected output.
- **Type consistency:** the helper is exported as `resolvePtyLocaleEnv` everywhere (Task 1 definition + Task 2 import + Task 2 spread calls). The env var name `AGENTQUAD_KEEP_CJK_LOCALE` is identical in code, tests, README, and commit messages.
- **Spec gap check:** §7 spec lists three pending decisions; the plan locks them to the spec's defaults (`en_US.UTF-8`, `AGENTQUAD_KEEP_CJK_LOCALE=1`, `LANG`+`LC_CTYPE` only). If the user wants other values, change Task 1 helper + Task 1 tests + Task 4 README in lockstep.
