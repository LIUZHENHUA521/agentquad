# 本地直起 claude/codex 会话自动同步 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在终端直起的 `claude` / `codex` 会话自动同步到 AgentQuad web 端、套上默认 Telegram/飞书通知路由，并提供 web 端「接管」按钮把会话 PTY 转交给 AgentQuad。

**Architecture:** 复用现有 hook 通路（`openclaw-hook-installer` 装的 claude hooks、`codex-hook-installer` 装的 codex hooks）。在 `src/openclaw-hook.js` 主 handler 里加「无匹配 todo → auto-create + 套默认路由」分支，sqlite 事务保证幂等。状态用 hook event 离散切换（claude 全四态，codex 缺 pending_confirm）。

**Tech Stack:** Node.js ESM (backend, plain JS) · better-sqlite3 · Express + ws · React 18 + TypeScript + Vite + Antd (frontend) · vitest (test runner)

**Spec:** `docs/superpowers/specs/2026-05-23-local-session-auto-capture-design.md`

---

## File Map

新建：
- `test/db.local-capture.test.js`
- `test/openclaw-hook.local-capture.test.js`
- `test/openclaw-hook-installer.session-start.test.js`
- `test/routes/ai-terminal.adopt-local.test.js`
- `test/local-session-tick.test.js`
- `src/local-session-tick.js` — codex 30min 超时收尾的后台 tick
- `docs/LOCAL-SESSIONS.md`

改：
- `src/config.js` — 加 `DEFAULT_LOCAL_SESSIONS_CONFIG`
- `src/db.js` — 加 `findTodoByNativeSessionId` / `createLocalCaptureTodo` / `renameLocalCaptureTitleIfMatches` / `setAiSessionFields`
- `src/openclaw-hook.js` — handler 入口加 ensure-todo 分支，事件分发处加 status 翻转
- `src/openclaw-hook-installer.js` — HOOK_EVENTS 加 `SessionStart`，version +1
- `src/routes/ai-terminal.js` — 加 `POST /adopt-local`
- `src/server.js` — bootstrap 加 hook 版本检查，`/api/status` 返回 `hookOutdated`，启动 local-session-tick
- `web/src/components/TodoCard/TodoCard.tsx` — source=local-capture 时显示「接管」按钮 + Modal.confirm
- `web/src/api.ts` — 加 `adoptLocalSession()`，扩 status 接口含 `hookOutdated`
- `web/src/components/TopbarDispatch/TopbarDispatch.tsx`（或 App 顶层）— 渲染 `hookOutdated` banner
- `docs/OPENCLAW.md` — 补 SessionStart hook 说明

---

## Task 0: 起 worktree

**Skill 调度**：在执行器侧由 `superpowers:using-git-worktrees` 接手。直接告诉执行器：

```
worktree branch: feat/local-session-auto-capture
worktree path: ../quadtodo-local-capture
```

之后所有 task 在该 worktree 内执行。

---

## Task 1: config 加 `localSessions` 默认值

**Files:**
- Modify: `src/config.js`
- Test: `test/config.local-sessions.test.js`（新）

- [ ] **Step 1: 写 failing test**

```js
// test/config.local-sessions.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

describe('localSessions config', () => {
  let rootDir
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'aq-cfg-'))
  })
  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('loadConfig 默认应包含 localSessions 子树', async () => {
    const cfg = await loadConfig({ rootDir })
    expect(cfg.localSessions).toBeDefined()
    expect(cfg.localSessions.autoCapture.enabled).toBe(true)
    expect(cfg.localSessions.autoCapture.redactCwd).toBe('basename')
    expect(cfg.localSessions.defaultTelegramRoute).toBeNull()
    expect(cfg.localSessions.defaultLarkRoute).toBeNull()
    expect(cfg.localSessions.skipEnvVar).toBe('AGENTQUAD_SKIP_CAPTURE')
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/config.local-sessions.test.js
```
Expected: FAIL — `cfg.localSessions` is undefined

- [ ] **Step 3: 实现**

在 `src/config.js` 现有 `DEFAULT_*` 配置区域加入：

```js
const DEFAULT_LOCAL_SESSIONS_CONFIG = Object.freeze({
  autoCapture: Object.freeze({
    enabled: true,
    redactCwd: 'basename'      // 'basename' | 'full' | 'none'
  }),
  defaultTelegramRoute: null,
  defaultLarkRoute: null,
  skipEnvVar: 'AGENTQUAD_SKIP_CAPTURE'
})
```

并在合并默认值的位置（搜 `DEFAULT_TELEGRAM_CONFIG` 周围的 merge 逻辑）加上：

```js
localSessions: {
  ...DEFAULT_LOCAL_SESSIONS_CONFIG,
  ...(raw.localSessions ?? {}),
  autoCapture: {
    ...DEFAULT_LOCAL_SESSIONS_CONFIG.autoCapture,
    ...(raw.localSessions?.autoCapture ?? {})
  }
}
```

导出 `DEFAULT_LOCAL_SESSIONS_CONFIG`（用于 db helper 取默认 fallback）。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/config.local-sessions.test.js
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.local-sessions.test.js
git commit -m "feat(config): add localSessions defaults for auto-capture"
git push origin HEAD
```

---

## Task 2: db 加 `findTodoByNativeSessionId`

**Files:**
- Modify: `src/db.js`
- Test: `test/db.local-capture.test.js`（新）

- [ ] **Step 1: 写 failing test**

```js
// test/db.local-capture.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'

describe('findTodoByNativeSessionId', () => {
  let db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  it('能查到 aiSessions 中含指定 nativeSessionId 的 todo', () => {
    const todo = db.createTodo({
      title: 'host',
      aiSessions: [{
        sessionId: 'sess-1',
        nativeSessionId: 'native-abc',
        tool: 'claude',
        status: 'running',
        startedAt: Date.now()
      }]
    })
    const found = db.findTodoByNativeSessionId('native-abc')
    expect(found?.id).toBe(todo.id)
  })

  it('不存在时返回 null', () => {
    expect(db.findTodoByNativeSessionId('nope')).toBeNull()
  })

  it('archived todo 不被返回', () => {
    const todo = db.createTodo({
      title: 'archived',
      aiSessions: [{ sessionId: 's', nativeSessionId: 'native-x', tool: 'claude', status: 'running' }]
    })
    db.archiveTodo(todo.id)
    expect(db.findTodoByNativeSessionId('native-x')).toBeNull()
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/db.local-capture.test.js
```
Expected: FAIL — `db.findTodoByNativeSessionId is not a function`

- [ ] **Step 3: 实现**

在 `src/db.js` 的查询区域（`listTodos` 附近）加入：

```js
function findTodoByNativeSessionId(nativeId) {
  if (!nativeId) return null
  // 用 LIKE 在 ai_session JSON 文本里模糊匹配（够快，sqlite 没有 json_each path 匹配的便捷写法）
  // 再在 JS 端精确校验，避免子串误匹配
  const candidates = db.prepare(`
    SELECT * FROM todos
    WHERE archived_at IS NULL
      AND ai_session LIKE @needle
  `).all({ needle: `%${nativeId}%` })

  for (const row of candidates) {
    const sessions = normalizeAiSessions(row.ai_session ? JSON.parse(row.ai_session) : [])
    if (sessions.some(s => s.nativeSessionId === nativeId)) {
      return rowToTodo(row)   // 复用已有 row → object 映射函数（见文件中 listTodos 用法）
    }
  }
  return null
}
```

加到导出对象 `return { ..., findTodoByNativeSessionId }`。

如果文件里没有 `rowToTodo`，复用 `listTodos` 里把 row 转 object 的同一段逻辑，抽成共享 fn 或就地映射。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/db.local-capture.test.js
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.local-capture.test.js
git commit -m "feat(db): findTodoByNativeSessionId for hook-driven binding lookup"
git push origin HEAD
```

---

## Task 3: db 加 `createLocalCaptureTodo`（事务幂等）

**Files:**
- Modify: `src/db.js`
- Test: extend `test/db.local-capture.test.js`

- [ ] **Step 1: 写 failing test（追加到同文件）**

```js
describe('createLocalCaptureTodo', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  const baseInput = {
    tool: 'claude',
    nativeSessionId: 'native-1',
    cwd: '/Users/me/projects/crazyCombo',
    initialPrompt: null,
    defaults: {
      defaultTelegramRoute: { chatId: 999 },
      defaultLarkRoute: null
    }
  }

  it('Phase 1 标题：[本地 claude] crazyCombo · HH:mm', () => {
    const todo = db.createLocalCaptureTodo(baseInput)
    expect(todo.title).toMatch(/^\[本地 claude\] crazyCombo · \d{2}:\d{2}$/)
    expect(todo.workDir).toBe('/Users/me/projects/crazyCombo')
  })

  it('aiSessions[0] 包含 nativeSessionId + source=local-capture + 默认路由', () => {
    const todo = db.createLocalCaptureTodo(baseInput)
    expect(todo.aiSessions).toHaveLength(1)
    const s = todo.aiSessions[0]
    expect(s.nativeSessionId).toBe('native-1')
    expect(s.tool).toBe('claude')
    expect(s.source).toBe('local-capture')
    expect(s.status).toBe('running')
    expect(s.telegramRoute).toEqual({ chatId: 999 })
    expect(s.larkRoute).toBeNull()
  })

  it('codex + initialPrompt → 标题带 prompt 摘要', () => {
    const todo = db.createLocalCaptureTodo({
      ...baseInput,
      tool: 'codex',
      nativeSessionId: 'native-2',
      initialPrompt: '帮我看看 X 是什么意思 然后呢'
    })
    expect(todo.title).toMatch(/^\[本地 codex\] crazyCombo · "帮我看看 X 是什么意思 然后呢…"$/)
  })

  it('幂等：并发调用 5 次同 nativeSessionId 只建 1 张', () => {
    const results = Array.from({ length: 5 }, () => db.createLocalCaptureTodo(baseInput))
    const ids = new Set(results.map(t => t.id))
    expect(ids.size).toBe(1)
    expect(db.listTodos({}).filter(t => !t.archived).length).toBe(1)
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/db.local-capture.test.js
```
Expected: FAIL — `db.createLocalCaptureTodo is not a function`

- [ ] **Step 3: 实现**

在 `src/db.js` 加：

```js
const LOCAL_CAPTURE_TITLE_RE = /^\[本地 (claude|codex)\] .+ · \d{2}:\d{2}$/

function formatHHmm(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function summarizePrompt(prompt, maxChars = 30) {
  if (!prompt) return null
  const collapsed = String(prompt).trim().replace(/\s+/g, ' ')
  if (!collapsed) return null
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed
}

function buildLocalCaptureTitle({ tool, cwd, initialPrompt, now = new Date() }) {
  const basename = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : '(unknown)'
  const summary = summarizePrompt(initialPrompt)
  const base = `[本地 ${tool}] ${basename} · ${formatHHmm(now)}`
  return summary ? `[本地 ${tool}] ${basename} · "${summary}"` : base
}

function createLocalCaptureTodo({ tool, nativeSessionId, cwd, initialPrompt, defaults = {}, now = new Date() }) {
  return db.transaction(() => {
    const existing = findTodoByNativeSessionId(nativeSessionId)
    if (existing) return existing

    const session = {
      sessionId: randomUUID(),                  // import { randomUUID } from 'node:crypto'
      nativeSessionId,
      tool,
      status: 'running',
      startedAt: now.getTime(),
      source: 'local-capture',
      telegramRoute: defaults.defaultTelegramRoute ?? null,
      larkRoute: defaults.defaultLarkRoute ?? null
    }

    return createTodo({
      title: buildLocalCaptureTitle({ tool, cwd, initialPrompt, now }),
      description: initialPrompt ? String(initialPrompt).slice(0, 200) : '',
      workDir: cwd || null,
      aiSessions: [session]
    })
  })()
}
```

在导出对象加上 `createLocalCaptureTodo`, `LOCAL_CAPTURE_TITLE_RE`, `buildLocalCaptureTitle`, `summarizePrompt`（后三个供 Task 4 / openclaw-hook 复用）。

如果 `createTodo` 现在签名不支持 `workDir` / `aiSessions` 字段名，参考其内部 mapping 表（`src/db.js:417` 附近的 `quadrant: 'quadrant'` 那种 alias map）补字段。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/db.local-capture.test.js
```
Expected: PASS (7 tests total in this file)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.local-capture.test.js
git commit -m "feat(db): createLocalCaptureTodo with idempotent transaction"
git push origin HEAD
```

---

## Task 4: db 加 `renameLocalCaptureTitleIfMatches`（Phase 2 rename）

**Files:**
- Modify: `src/db.js`
- Test: extend `test/db.local-capture.test.js`

- [ ] **Step 1: 写 failing test（追加）**

```js
describe('renameLocalCaptureTitleIfMatches', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('当前 title 仍是 Phase 1 模板时才 rename', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'n-rename-1',
      cwd: '/x/proj',
      defaults: {}
    })
    const ok = db.renameLocalCaptureTitleIfMatches(todo.id, '[本地 claude] proj · "帮我做 Y…"')
    expect(ok).toBe(true)
    expect(db.getTodo(todo.id).title).toBe('[本地 claude] proj · "帮我做 Y…"')
  })

  it('用户已经改过标题就不动', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude',
      nativeSessionId: 'n-rename-2',
      cwd: '/x/proj',
      defaults: {}
    })
    db.updateTodo(todo.id, { title: '用户改的标题' })
    const ok = db.renameLocalCaptureTitleIfMatches(todo.id, '[本地 claude] proj · "应当被忽略…"')
    expect(ok).toBe(false)
    expect(db.getTodo(todo.id).title).toBe('用户改的标题')
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/db.local-capture.test.js -t renameLocalCaptureTitleIfMatches
```
Expected: FAIL — `db.renameLocalCaptureTitleIfMatches is not a function`

- [ ] **Step 3: 实现**

```js
function renameLocalCaptureTitleIfMatches(todoId, newTitle) {
  const todo = getTodo(todoId)
  if (!todo) return false
  if (!LOCAL_CAPTURE_TITLE_RE.test(todo.title)) return false
  updateTodo(todoId, { title: newTitle })
  return true
}
```

加到导出对象。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/db.local-capture.test.js
```
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.local-capture.test.js
git commit -m "feat(db): renameLocalCaptureTitleIfMatches guards user edits"
git push origin HEAD
```

---

## Task 5: db 加 `setAiSessionFields` helper

**Files:**
- Modify: `src/db.js`
- Test: extend `test/db.local-capture.test.js`

- [ ] **Step 1: 写 failing test（追加）**

```js
describe('setAiSessionFields', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('能更新 aiSessions[i] 的 status / source / lastStopAt', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude', nativeSessionId: 'n-up-1', cwd: '/x', defaults: {}
    })
    const sid = todo.aiSessions[0].sessionId
    db.setAiSessionFields(todo.id, sid, {
      status: 'pending_confirm',
      lastStopAt: 1234567890,
      source: 'adopted'
    })
    const fresh = db.getTodo(todo.id).aiSessions[0]
    expect(fresh.status).toBe('pending_confirm')
    expect(fresh.lastStopAt).toBe(1234567890)
    expect(fresh.source).toBe('adopted')
  })

  it('未知 sessionId 返回 false 且不破坏其它 session', () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude', nativeSessionId: 'n-up-2', cwd: '/x', defaults: {}
    })
    const ok = db.setAiSessionFields(todo.id, 'no-such-sid', { status: 'done' })
    expect(ok).toBe(false)
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('running')
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/db.local-capture.test.js -t setAiSessionFields
```
Expected: FAIL — undefined

- [ ] **Step 3: 实现**

```js
function setAiSessionFields(todoId, sessionId, patch) {
  const todo = getTodo(todoId)
  if (!todo) return false
  const sessions = normalizeAiSessions(todo.aiSessions)
  const idx = sessions.findIndex(s => s.sessionId === sessionId)
  if (idx < 0) return false
  sessions[idx] = { ...sessions[idx], ...patch }
  updateTodo(todoId, { aiSessions: sessions })
  return true
}
```

加到导出对象。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/db.local-capture.test.js
```
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.local-capture.test.js
git commit -m "feat(db): setAiSessionFields for hook-driven status updates"
git push origin HEAD
```

---

## Task 6: openclaw-hook 加 `ensureTodoForLocalSession` 分支

**Files:**
- Modify: `src/openclaw-hook.js`
- Test: `test/openclaw-hook.local-capture.test.js`（新）

- [ ] **Step 1: 写 failing test**

```js
// test/openclaw-hook.local-capture.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { createOpenClawHookHandler } from '../src/openclaw-hook.js'

function fakeBridge() {
  return {
    broadcastText: vi.fn().mockResolvedValue({ ok: true }),
    postCard: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    hasExplicitRoute: vi.fn().mockReturnValue(false),
    resolveRoute: vi.fn().mockReturnValue(null)
  }
}

function makeHandler({ db, autoCapture = true, skipEnv = false } = {}) {
  return createOpenClawHookHandler({
    db,
    config: {
      localSessions: {
        autoCapture: { enabled: autoCapture, redactCwd: 'basename' },
        defaultTelegramRoute: { chatId: 42 },
        defaultLarkRoute: null,
        skipEnvVar: 'AGENTQUAD_SKIP_CAPTURE'
      }
    },
    openclaw: fakeBridge(),
    codexBridge: fakeBridge(),
    aiTerminal: { sessions: new Map() },
    nowFn: () => new Date('2026-05-23T14:35:00Z')
  })
}

describe('openclaw-hook local capture', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('无匹配 todo + autoCapture on + claude SessionStart → 建一张 todo', async () => {
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'claude',
      path: 'hook-event',
      hookPayload: {
        hook_event_name: 'SessionStart',
        session_id: 'native-fresh',
        cwd: '/Users/me/proj-A',
        tool: 'claude'
      }
    })
    const todo = db.findTodoByNativeSessionId('native-fresh')
    expect(todo).not.toBeNull()
    expect(todo.title).toMatch(/^\[本地 claude\] proj-A · \d{2}:\d{2}$/)
    expect(todo.aiSessions[0].telegramRoute).toEqual({ chatId: 42 })
  })

  it('autoCapture off → 不建 todo', async () => {
    const handler = makeHandler({ db, autoCapture: false })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-x', cwd: '/x', tool: 'claude' }
    })
    expect(db.findTodoByNativeSessionId('native-x')).toBeNull()
  })

  it('env 含 AGENTQUAD_SKIP_CAPTURE=1 → 不建', async () => {
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: {
        hook_event_name: 'SessionStart',
        session_id: 'native-skip',
        cwd: '/x',
        tool: 'claude',
        env: { AGENTQUAD_SKIP_CAPTURE: '1' }
      }
    })
    expect(db.findTodoByNativeSessionId('native-skip')).toBeNull()
  })

  it('已绑定 todo → 不重复建，沿用原流程', async () => {
    const existing = db.createTodo({
      title: '已有',
      aiSessions: [{ sessionId: 's1', nativeSessionId: 'native-bound', tool: 'claude', status: 'running' }]
    })
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-bound', cwd: '/x', tool: 'claude' }
    })
    const all = db.listTodos({})
    expect(all.length).toBe(1)
    expect(all[0].id).toBe(existing.id)
  })

  it('codex UserPromptSubmit 带 prompt → 一次性带摘要建卡', async () => {
    const handler = makeHandler({ db })
    await handler.handle({
      source: 'codex', path: 'hook-event',
      hookPayload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'native-codex-1',
        cwd: '/Users/me/proj-B',
        tool: 'codex',
        prompt: '帮我写一个 hello world'
      }
    })
    const todo = db.findTodoByNativeSessionId('native-codex-1')
    expect(todo.title).toMatch(/^\[本地 codex\] proj-B · "帮我写一个 hello world"$/)
  })

  it('并发 5 次同 nativeSessionId → 只建 1 张', async () => {
    const handler = makeHandler({ db })
    const payload = {
      source: 'claude', path: 'hook-event',
      hookPayload: { hook_event_name: 'SessionStart', session_id: 'native-race', cwd: '/x', tool: 'claude' }
    }
    await Promise.all(Array.from({ length: 5 }, () => handler.handle(payload)))
    expect(db.listTodos({}).filter(t => t.aiSessions?.[0]?.nativeSessionId === 'native-race').length).toBe(1)
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/openclaw-hook.local-capture.test.js
```
Expected: FAIL — 几个 case 的 `findTodoByNativeSessionId` 返回 null（没建出来）

- [ ] **Step 3: 实现**

在 `src/openclaw-hook.js`：

**1)** 在 `createOpenClawHookHandler` 函数顶部 deps 解构里加 `db, config`：

```js
function createOpenClawHookHandler({
  db,
  config,
  openclaw,
  codexBridge,
  aiTerminal,
  nowFn = () => new Date(),
  ...
} = {}) {
```

**2)** 加一个 `ensureTodoForLocalSession` 辅助函数（放在 handle() 之前）：

```js
const CAPTURE_EVENTS_CLAUDE = new Set(['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop'])
const CAPTURE_EVENTS_CODEX = new Set(['UserPromptSubmit', 'Stop'])

function shouldCapture(tool, event) {
  if (tool === 'claude') return CAPTURE_EVENTS_CLAUDE.has(event)
  if (tool === 'codex') return CAPTURE_EVENTS_CODEX.has(event)
  return false
}

async function ensureTodoForLocalSession({ tool, sessionId, event, cwd, prompt, env }) {
  if (!db || !config?.localSessions) return null
  if (!sessionId || !tool || !cwd) return null

  const ls = config.localSessions
  const skipVar = ls.skipEnvVar || 'AGENTQUAD_SKIP_CAPTURE'
  if (env && env[skipVar]) return null

  let todo = db.findTodoByNativeSessionId(sessionId)
  if (todo) {
    // Phase 2 rename：claude SessionStart 之后第一次拿到 prompt
    if (tool === 'claude' && event === 'UserPromptSubmit' && prompt) {
      const summary = summarizePromptForTitle(prompt)   // 内联或 import 自 db.js
      if (summary) {
        const basename = (cwd.split(/[\\/]/).filter(Boolean).pop()) || cwd
        const newTitle = `[本地 claude] ${basename} · "${summary}"`
        db.renameLocalCaptureTitleIfMatches(todo.id, newTitle)
        todo = db.getTodo(todo.id)
      }
    }
    return todo
  }

  if (!ls.autoCapture?.enabled) return null
  if (!shouldCapture(tool, event)) return null

  todo = db.createLocalCaptureTodo({
    tool,
    nativeSessionId: sessionId,
    cwd,
    initialPrompt: event === 'UserPromptSubmit' ? prompt : null,
    defaults: ls,
    now: nowFn()
  })
  return todo
}

function summarizePromptForTitle(prompt, max = 30) {
  if (!prompt) return null
  const c = String(prompt).trim().replace(/\s+/g, ' ')
  if (!c) return null
  return c.length > max ? `${c.slice(0, max)}…` : c
}
```

**3)** 在 `handle()` 主入口（约第 483 行）拆解 hookPayload 后，调用 `ensureTodoForLocalSession`，把返回的 todo 注入下游 handleClaude / handleCodexJsonl 的上下文。最小改动：

```js
async function handle(req = {}) {
  const tool = req.source === 'codex' ? 'codex' : 'claude'
  const hp = req.hookPayload || {}
  const event = hp.hook_event_name
  const sessionId = hp.session_id

  const localTodo = await ensureTodoForLocalSession({
    tool,
    sessionId,
    event,
    cwd: hp.cwd,
    prompt: hp.prompt,
    env: hp.env
  })

  // 把 localTodo 透传给已有分发逻辑（如果原 handle 通过 db.findTodoByXxx 反查，
  // 我们这里就让原路径也能找到它——因为已经写入 db 了）
  return _dispatch(req)   // 原 handle 主体保留为 _dispatch
}
```

> ⚠️ 如果原 handle 主体的代码结构不便拆分，最小侵入做法是只在原入口的最前面插入 `ensureTodoForLocalSession` 调用（不消费返回值），让后续原逻辑通过 db 查询自然拿到新建的 todo。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/openclaw-hook.local-capture.test.js
```
Expected: PASS (6 tests)

```bash
npx vitest run test/openclaw-hook.test.js test/openclaw-hook.codex.test.js test/openclaw-hook.stop-gating.test.js
```
Expected: PASS — 现有 openclaw-hook 测试不能挂

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.local-capture.test.js
git commit -m "feat(openclaw-hook): auto-create todo for unbound local sessions"
git push origin HEAD
```

---

## Task 7: 状态映射（hook event → aiSessions[].status）

**Files:**
- Modify: `src/openclaw-hook.js`
- Test: extend `test/openclaw-hook.local-capture.test.js`

- [ ] **Step 1: 写 failing test（追加）**

```js
describe('local capture status mapping', () => {
  let db, handler
  beforeEach(() => {
    db = openDb(':memory:')
    handler = makeHandler({ db })
  })

  async function fire(event, extra = {}) {
    await handler.handle({
      source: extra.tool === 'codex' ? 'codex' : 'claude',
      path: 'hook-event',
      hookPayload: {
        hook_event_name: event,
        session_id: 'native-status',
        cwd: '/x',
        tool: extra.tool || 'claude',
        ...extra.payload
      }
    })
  }

  it('claude SessionStart → running', async () => {
    await fire('SessionStart')
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).toBe('running')
  })

  it('claude Notification → pending_confirm', async () => {
    await fire('SessionStart')
    await fire('Notification', { payload: { message: '需要批准 Bash', tool_input: { command: 'ls' } } })
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).toBe('pending_confirm')
  })

  it('claude Stop → idle', async () => {
    await fire('SessionStart')
    await fire('Stop')
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).toBe('idle')
  })

  it('claude SessionEnd → done + completedAt', async () => {
    await fire('SessionStart')
    await fire('SessionEnd')
    const s = db.findTodoByNativeSessionId('native-status').aiSessions[0]
    expect(s.status).toBe('done')
    expect(s.completedAt).toBeGreaterThan(0)
  })

  it('codex Stop → idle 且记录 lastStopAt', async () => {
    await fire('UserPromptSubmit', { tool: 'codex', payload: { prompt: 'hi' } })
    await fire('Stop', { tool: 'codex' })
    const s = db.findTodoByNativeSessionId('native-status').aiSessions[0]
    expect(s.status).toBe('idle')
    expect(s.lastStopAt).toBeGreaterThan(0)
  })

  it('codex 不会被翻成 pending_confirm（codex hook 协议无该事件）', async () => {
    await fire('UserPromptSubmit', { tool: 'codex', payload: { prompt: 'hi' } })
    // codex Stop 之后不应进入 pending_confirm
    await fire('Stop', { tool: 'codex' })
    expect(db.findTodoByNativeSessionId('native-status').aiSessions[0].status).not.toBe('pending_confirm')
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/openclaw-hook.local-capture.test.js -t "status mapping"
```
Expected: 多数 fail — status 保持 'running' 或字段不变

- [ ] **Step 3: 实现**

在 `ensureTodoForLocalSession` 内部、找到/建出 todo 之后，按 event 调 `setAiSessionFields`：

```js
async function applyStatusFromHookEvent({ todo, tool, event, nowMs }) {
  if (!todo) return
  const sid = todo.aiSessions?.[0]?.sessionId
  if (!sid) return

  const patch = {}

  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    patch.status = 'running'
  } else if (event === 'Notification' && tool === 'claude') {
    patch.status = 'pending_confirm'
  } else if (event === 'Stop') {
    patch.status = 'idle'
    patch.lastStopAt = nowMs
  } else if (event === 'SessionEnd' && tool === 'claude') {
    patch.status = 'done'
    patch.completedAt = nowMs
  }

  if (Object.keys(patch).length) {
    db.setAiSessionFields(todo.id, sid, patch)
  }
}
```

在 `ensureTodoForLocalSession` 末尾返回前调用：

```js
await applyStatusFromHookEvent({ todo, tool, event, nowMs: nowFn().getTime() })
return todo
```

注意：**只对 source='local-capture' 或 'adopted' 的 session 应用** —— web 端 session 走 PtyManager 状态机，不能被 hook 直接覆盖。在 patch 之前加：

```js
const session = todo.aiSessions?.[0]
if (!session || (session.source !== 'local-capture' && session.source !== 'adopted')) return
```

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/openclaw-hook.local-capture.test.js
```
Expected: PASS (12 tests)

```bash
npx vitest run
```
Expected: 所有现有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-hook.js test/openclaw-hook.local-capture.test.js
git commit -m "feat(openclaw-hook): map hook events to aiSessions status for local capture"
git push origin HEAD
```

---

## Task 8: codex 30min 静默超时 (`local-session-tick.js`)

**Files:**
- Create: `src/local-session-tick.js`
- Test: `test/local-session-tick.test.js`

- [ ] **Step 1: 写 failing test**

```js
// test/local-session-tick.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import { runLocalSessionTick } from '../src/local-session-tick.js'

const THIRTY_MIN_MS = 30 * 60 * 1000

describe('runLocalSessionTick', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  it('codex idle 且 lastStopAt > 30min → 翻 done', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-1',
      aiSessions: [{
        sessionId: 's1', nativeSessionId: 'n1', tool: 'codex',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    const s = db.getTodo(todo.id).aiSessions[0]
    expect(s.status).toBe('done')
    expect(s.completedAt).toBe(now)
  })

  it('lastStopAt < 30min → 不动', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-2',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n2', tool: 'codex',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - 5 * 60 * 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
  })

  it('claude session 不受影响（claude 有 SessionEnd）', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'claude-1',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n3', tool: 'claude',
        status: 'idle', source: 'local-capture',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
  })

  it('source=web 的 codex 不受影响', () => {
    const now = 1_700_000_000_000
    const todo = db.createTodo({
      title: 'codex-web',
      aiSessions: [{
        sessionId: 's', nativeSessionId: 'n4', tool: 'codex',
        status: 'idle', source: 'web',
        lastStopAt: now - THIRTY_MIN_MS - 1000
      }]
    })
    runLocalSessionTick({ db, now })
    expect(db.getTodo(todo.id).aiSessions[0].status).toBe('idle')
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/local-session-tick.test.js
```
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```js
// src/local-session-tick.js
const CODEX_SILENT_TIMEOUT_MS = 30 * 60 * 1000

export function runLocalSessionTick({ db, now = Date.now(), logger } = {}) {
  if (!db) return
  // 简单实现：扫所有非归档 todo，找 codex + local-capture/adopted + idle + lastStopAt 过期
  const todos = db.listTodos({})
  for (const todo of todos) {
    const sessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []
    for (const s of sessions) {
      if (s.tool !== 'codex') continue
      if (s.source !== 'local-capture' && s.source !== 'adopted') continue
      if (s.status !== 'idle') continue
      if (!s.lastStopAt) continue
      if (now - s.lastStopAt < CODEX_SILENT_TIMEOUT_MS) continue
      db.setAiSessionFields(todo.id, s.sessionId, {
        status: 'done',
        completedAt: now
      })
      logger?.info?.({ todoId: todo.id, sessionId: s.sessionId }, 'codex local session timed out')
    }
  }
}

export function startLocalSessionTick({ db, intervalMs = 60_000, logger } = {}) {
  const handle = setInterval(() => {
    try { runLocalSessionTick({ db, logger }) }
    catch (e) { logger?.error?.({ err: e }, 'local-session-tick error') }
  }, intervalMs)
  if (handle.unref) handle.unref()
  return () => clearInterval(handle)
}
```

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/local-session-tick.test.js
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/local-session-tick.js test/local-session-tick.test.js
git commit -m "feat: local-session-tick for codex 30min silent-timeout"
git push origin HEAD
```

---

## Task 9: openclaw-hook-installer 加 `SessionStart`，版本号 +1

**Files:**
- Modify: `src/openclaw-hook-installer.js`
- Test: `test/openclaw-hook-installer.session-start.test.js`（新）

- [ ] **Step 1: 写 failing test**

```js
// test/openclaw-hook-installer.session-start.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHooks,
  HOOK_EVENTS,
  EXPECTED_HOOK_VERSION   // 新导出
} from '../src/openclaw-hook-installer.js'

describe('SessionStart hook install', () => {
  let dir, settingsPath, scriptPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-hook-'))
    settingsPath = join(dir, '.claude.json')
    scriptPath = join(dir, 'notify.js')
    writeFileSync(scriptPath, 'export default 1')
  })

  it('HOOK_EVENTS 包含 SessionStart', () => {
    expect(HOOK_EVENTS).toContain('SessionStart')
    expect(HOOK_EVENTS).toContain('Stop')
    expect(HOOK_EVENTS).toContain('Notification')
    expect(HOOK_EVENTS).toContain('SessionEnd')
    expect(HOOK_EVENTS).toContain('UserPromptSubmit')
  })

  it('install 后 settings.json 含 SessionStart entry', () => {
    installHooks({ settingsPath, hookScriptPath: scriptPath, events: HOOK_EVENTS })
    const json = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(json.hooks?.SessionStart).toBeDefined()
    expect(Array.isArray(json.hooks.SessionStart)).toBe(true)
    expect(json.hooks.SessionStart.length).toBeGreaterThan(0)
  })

  it('版本号被注入并 ≥ 期望版本', () => {
    installHooks({ settingsPath, hookScriptPath: scriptPath, events: HOOK_EVENTS })
    const raw = readFileSync(settingsPath, 'utf8')
    const m = raw.match(/quadtodo-hook-version:\s*(\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m[1])).toBeGreaterThanOrEqual(EXPECTED_HOOK_VERSION)
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/openclaw-hook-installer.session-start.test.js
```
Expected: FAIL — `SessionStart` 不在 HOOK_EVENTS / `EXPECTED_HOOK_VERSION` 未导出

- [ ] **Step 3: 实现**

在 `src/openclaw-hook-installer.js`：

```js
// 第 26 行附近
export const HOOK_EVENTS = ['SessionStart', 'Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit']

// 新增（找现有 EXPECTED_VERSION / HOOK_VERSION 常量；若没有则新增）
export const EXPECTED_HOOK_VERSION = 2   // 原版本是 1（或当前实际值 + 1）

// 确保 installHooks() 写入 quadtodo-hook-version: <EXPECTED_HOOK_VERSION>
// 找原本写 version 注释的地方，把数字换成 EXPECTED_HOOK_VERSION
```

> 实施时先 `grep -n "quadtodo-hook-version" src/openclaw-hook-installer.js` 确认现有版本号字面量在哪里。

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/openclaw-hook-installer.session-start.test.js
npx vitest run test/openclaw-hook-installer.test.js   # 若存在，确保不回归
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/openclaw-hook-installer.js test/openclaw-hook-installer.session-start.test.js
git commit -m "feat(hook-installer): add SessionStart event, bump hook version"
git push origin HEAD
```

---

## Task 10: `/api/status` 返回 `hookOutdated`

**Files:**
- Modify: `src/server.js`
- Test: `test/server.status-hook-outdated.test.js`（新）

- [ ] **Step 1: 写 failing test**

```js
// test/server.status-hook-outdated.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'   // 若 server.js 没导出 createApp 则按现有模式 import

// 这个测试需要 mock 现有 inspectHooks 返回旧版本
import * as installer from '../src/openclaw-hook-installer.js'

describe('GET /api/status hookOutdated', () => {
  let app
  beforeEach(() => {
    // 假装当前安装是版本 1（< EXPECTED_HOOK_VERSION=2）
    installer.__setMockedVersionForTest?.(1)
    app = createApp({ /* minimal deps */ })
  })
  afterEach(() => { installer.__setMockedVersionForTest?.(null) })

  it('当前 hook 版本旧 → hookOutdated: true', async () => {
    const r = await request(app).get('/api/status')
    expect(r.status).toBe(200)
    expect(r.body.hookOutdated).toBe(true)
  })
})
```

> 如果 `src/server.js` 没有方便的 `createApp` 导出，先重构出一个；或者改为直接 mount router 测路由对象。

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/server.status-hook-outdated.test.js
```
Expected: FAIL

- [ ] **Step 3: 实现**

在 `src/server.js` bootstrap 阶段（找 `inspectHooks` 现有调用位置）：

```js
import { EXPECTED_HOOK_VERSION } from './openclaw-hook-installer.js'

let _hookVersionState = { current: null, expected: EXPECTED_HOOK_VERSION }

async function refreshHookVersionState() {
  try {
    const info = await inspectHooks({ /* paths */ })  // 现有 fn 或读 settings.json 解析 quadtodo-hook-version
    _hookVersionState.current = info?.version ?? null
  } catch { _hookVersionState.current = null }
}
await refreshHookVersionState()

// GET /api/status（第 649 行附近）
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    version: APP_VERSION,
    activeSessions: pty.activeSessionCount?.() ?? 0,
    hookOutdated: _hookVersionState.current != null
                  && _hookVersionState.current < _hookVersionState.expected
  })
})
```

为了让测试能注入版本，加：

```js
// src/openclaw-hook-installer.js
let _mockedVersion = null
export function __setMockedVersionForTest(v) { _mockedVersion = v }
export function getInstalledHookVersion(settingsPath) {
  if (_mockedVersion !== null) return _mockedVersion
  // 原本的读取逻辑
}
```

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/server.status-hook-outdated.test.js
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/openclaw-hook-installer.js test/server.status-hook-outdated.test.js
git commit -m "feat(server): /api/status reports hookOutdated for ui banner"
git push origin HEAD
```

---

## Task 11: `POST /api/ai-terminal/adopt-local`

**Files:**
- Modify: `src/routes/ai-terminal.js`
- Test: `test/routes/ai-terminal.adopt-local.test.js`（新）

- [ ] **Step 1: 写 failing test**

```js
// test/routes/ai-terminal.adopt-local.test.js
import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { openDb } from '../../src/db.js'
import { createAiTerminal } from '../../src/routes/ai-terminal.js'

class FakePty {
  constructor() { this.created = [] }
  spawn(spec) {
    this.created.push(spec)
    return { sessionId: spec.sessionId, ok: true }
  }
}

function makeApp(db, pty) {
  const ait = createAiTerminal({ db, pty, logDir: '/tmp/aq-logs', defaultCwd: '/tmp' })
  const app = express()
  app.use(express.json())
  app.use('/api/ai-terminal', ait.router)
  return app
}

describe('POST /api/ai-terminal/adopt-local', () => {
  let db, pty, app
  beforeEach(() => {
    db = openDb(':memory:')
    pty = new FakePty()
    app = makeApp(db, pty)
  })

  it('source=local-capture → 成功 spawn 含 resumeNativeId 并 source 翻 adopted', async () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude', nativeSessionId: 'native-adopt',
      cwd: '/Users/me/proj', defaults: {}
    })
    const sid = todo.aiSessions[0].sessionId

    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: sid })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(pty.created).toHaveLength(1)
    expect(pty.created[0].resumeNativeId).toBe('native-adopt')
    expect(pty.created[0].sessionId).toBe(sid)
    expect(pty.created[0].cwd).toBe('/Users/me/proj')

    const fresh = db.getTodo(todo.id).aiSessions[0]
    expect(fresh.source).toBe('adopted')
  })

  it('source=web → 400', async () => {
    const todo = db.createTodo({
      title: 'web',
      aiSessions: [{ sessionId: 'sw', nativeSessionId: 'nw', tool: 'claude', status: 'running', source: 'web' }]
    })
    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: 'sw' })
    expect(r.status).toBe(400)
    expect(pty.created).toHaveLength(0)
  })

  it('未知 sessionId → 404', async () => {
    const todo = db.createLocalCaptureTodo({
      tool: 'claude', nativeSessionId: 'native-a', cwd: '/x', defaults: {}
    })
    const r = await request(app)
      .post('/api/ai-terminal/adopt-local')
      .send({ todoId: todo.id, sessionId: 'no-such' })
    expect(r.status).toBe(404)
  })
})
```

- [ ] **Step 2: 验证 fail**

```bash
npx vitest run test/routes/ai-terminal.adopt-local.test.js
```
Expected: FAIL — 路由 404

- [ ] **Step 3: 实现**

在 `src/routes/ai-terminal.js` createAiTerminal 内部：

```js
router.post('/adopt-local', express.json(), async (req, res) => {
  const { todoId, sessionId } = req.body || {}
  if (!todoId || !sessionId) return res.status(400).json({ ok: false, error: 'missing_params' })

  const todo = db.getTodo(todoId)
  if (!todo) return res.status(404).json({ ok: false, error: 'todo_not_found' })

  const session = todo.aiSessions?.find(s => s.sessionId === sessionId)
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' })
  if (session.source !== 'local-capture') {
    return res.status(400).json({ ok: false, error: 'not_local_capture' })
  }

  try {
    await pty.spawn({
      tool: session.tool,
      cwd: todo.workDir || defaultCwd,
      resumeNativeId: session.nativeSessionId,
      sessionId,
      todoId
    })
    db.setAiSessionFields(todoId, sessionId, { source: 'adopted' })
    return res.json({ ok: true, sessionId, nativeSessionId: session.nativeSessionId })
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'spawn_failed', detail: e.message })
  }
})
```

- [ ] **Step 4: 验证 pass**

```bash
npx vitest run test/routes/ai-terminal.adopt-local.test.js
npx vitest run test/ai-terminal.route.test.js   # 现有路由测试
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/ai-terminal.js test/routes/ai-terminal.adopt-local.test.js
git commit -m "feat(api): POST /api/ai-terminal/adopt-local to take over local session"
git push origin HEAD
```

---

## Task 12: server 启动 local-session-tick

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: 改 + 手验**

在 `src/server.js` 启动流程（pty / routes 都 ready 之后）加：

```js
import { startLocalSessionTick } from './local-session-tick.js'

// ...
const stopTick = startLocalSessionTick({ db, logger })
// 服务关闭 hook 里 stopTick()
```

- [ ] **Step 2: 验证不破坏现有启动**

```bash
npm test
```
Expected: 所有现有 vitest 通过

```bash
npm start &
sleep 3
curl -s http://127.0.0.1:5677/api/status | jq .
npm run stop
```
Expected: `/api/status` 正常返回，server 启动无 unhandled error

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat(server): start local-session-tick on boot"
git push origin HEAD
```

---

## Task 13: 前端 `api.ts` 加 `adoptLocalSession` + `hookOutdated`

**Files:**
- Modify: `web/src/api.ts`

- [ ] **Step 1: 实现**

在 `web/src/api.ts` 现有 fetch wrapper 风格下加：

```ts
export type AiSessionSource = 'web' | 'local-capture' | 'adopted'

// 扩展 ServerStatus 接口（找现有 GET /api/status 的返回类型）
export interface ServerStatus {
  ok: boolean
  version: string
  activeSessions: number
  hookOutdated?: boolean    // 新增
}

export async function adoptLocalSession(todoId: number, sessionId: string) {
  const r = await fetch('/api/ai-terminal/adopt-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ todoId, sessionId })
  })
  if (!r.ok) throw new Error(`adopt failed: ${r.status}`)
  return r.json() as Promise<{ ok: boolean; sessionId: string; nativeSessionId: string }>
}
```

确保 `AiSession` 接口加上 `source?: AiSessionSource`。

- [ ] **Step 2: 验证 tsc**

```bash
cd web && npx tsc -b
```
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(web): api client for adoptLocalSession + hookOutdated status"
git push origin HEAD
```

---

## Task 14: 前端 TodoCard 加「接管」按钮

**Files:**
- Modify: `web/src/components/TodoCard/TodoCard.tsx`

- [ ] **Step 1: 实现**

找到现有 action 按钮区（参考其他按钮位置和样式），在卡片 header 加：

```tsx
import { Modal, Button } from 'antd'
import { adoptLocalSession } from '../../api'

function AdoptButton({ todoId, session, onAdopted }: {
  todoId: number
  session: { sessionId: string; nativeSessionId: string; tool: string; source?: string; status: string }
  onAdopted: () => void
}) {
  const visible = session.source === 'local-capture' && session.status === 'running'
  if (!visible) return null

  const handle = () => {
    Modal.confirm({
      title: '接管本地会话',
      content: (
        <>
          <p>即将通过 <code>{session.tool} --resume {session.nativeSessionId.slice(0, 8)}…</code> 在 AgentQuad 中接管这个会话。</p>
          <p><strong>请先在本地终端按 Ctrl+C 退出 {session.tool}</strong>，否则两个进程同时持有同一 session id 会出错。</p>
          <p>确认继续？</p>
        </>
      ),
      okText: '我已退出本地，接管',
      cancelText: '取消',
      onOk: async () => {
        try {
          await adoptLocalSession(todoId, session.sessionId)
          onAdopted()
        } catch (e) {
          Modal.error({ title: '接管失败', content: String(e) })
        }
      }
    })
  }

  return <Button size="small" onClick={handle}>接管</Button>
}
```

在 TodoCard 渲染处插入 `<AdoptButton ...>`，按现有 button 排版规范（参考相邻按钮）。

回顾用户的 memory：「No rounded corners on UI」—— button 用 `style={{ borderRadius: 0 }}` 或全局 theme 已经处理就免补。

- [ ] **Step 2: 手测**

```bash
npm run build && npm start
```
Open http://127.0.0.1:5677

手测：
1. 找一个 source=local-capture 的卡片（可以 `sqlite3 ~/.agentquad/data.db` 手动插一行测，或者真跑 `claude` 触发）
2. 看到「接管」按钮
3. 点击 → 看到 Modal
4. 取消 → 无副作用
5. 确认 → 后端 spawn，xterm 打开

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TodoCard/TodoCard.tsx
git commit -m "feat(web): adopt button on local-capture todo cards"
git push origin HEAD
```

---

## Task 15: 前端 hookOutdated banner

**Files:**
- Modify: `web/src/components/TopbarDispatch/TopbarDispatch.tsx`（或同级 App 顶层组件）

- [ ] **Step 1: 实现**

在 Topbar 渲染处加：

```tsx
import { Alert } from 'antd'
import { useEffect, useState } from 'react'

function HookOutdatedBanner() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(s => setShow(!!s.hookOutdated))
    // 已 dismiss 过则不再弹
    if (localStorage.getItem('hook-outdated-dismissed') === '1') setShow(false)
  }, [])
  if (!show) return null
  return (
    <Alert
      type="warning"
      showIcon
      closable
      message={<>claude hooks 已升级，请运行 <code>agentquad install claude</code> 让本地直起的会话自动同步到 web 端</>}
      onClose={() => localStorage.setItem('hook-outdated-dismissed', '1')}
      style={{ borderRadius: 0 }}
    />
  )
}
```

挂在 topbar 上方或合适位置（参考现有 banner / alert 用法，如果没有就放 TopbarDispatch 容器之上）。

- [ ] **Step 2: 手测**

```bash
npm run build && npm start
```

- 启动后清除 localStorage，刷新 → 如果当前 hook 版本旧应看到 banner
- 关掉 → 刷新不再弹

- [ ] **Step 3: Commit**

```bash
git add web/src/components/TopbarDispatch/TopbarDispatch.tsx
git commit -m "feat(web): hookOutdated banner with localStorage dismiss"
git push origin HEAD
```

---

## Task 16: 文档

**Files:**
- Create: `docs/LOCAL-SESSIONS.md`
- Modify: `docs/OPENCLAW.md`

- [ ] **Step 1: 写 docs/LOCAL-SESSIONS.md**

```markdown
# Local Session Auto-Capture

When you run `claude` or `codex` directly in a terminal (outside the AgentQuad web UI), AgentQuad can still detect the session via hook callbacks, create a matching todo card automatically, and route notifications to your default Telegram / Lark route.

## Setup

1. Install hooks: `agentquad install claude` (and `agentquad install codex` if you use Codex)
2. Configure default routes in `~/.agentquad/config.json`:

   ```json
   {
     "localSessions": {
       "autoCapture": { "enabled": true, "redactCwd": "basename" },
       "defaultTelegramRoute": { "chatId": YOUR_CHAT_ID },
       "defaultLarkRoute": null
     }
   }
   ```

3. Restart AgentQuad: `agentquad restart`

## Behavior

| Tool | Card appears when | Status flow |
|------|-------------------|-------------|
| claude | SessionStart hook (within 1-2s of `claude` launch) | running → pending_confirm (Notification) → idle (Stop) → done (SessionEnd) |
| codex | First `UserPromptSubmit` (after first prompt) | running → idle (Stop) → done (30min silent timeout) |

**codex limitation**: codex hook protocol has no equivalent of claude's `Notification` event, so codex local sessions never enter the "pending_confirm" board column. Adopting the session (see below) lifts this restriction.

## Title Convention

- Phase 1 (at creation): `[本地 claude] <cwd-basename> · HH:mm`
- Phase 2 (after first prompt, claude only): `[本地 claude] <cwd-basename> · "<first 30 chars of prompt>…"`
- User-edited titles are protected: a rename only fires when the current title still matches the Phase 1 regex.

## Opt-Out

- Globally: `localSessions.autoCapture.enabled = false`
- One-shot: `AGENTQUAD_SKIP_CAPTURE=1 claude`

## Adopting a Session

A web "接管" (Take Over) button appears on local-capture cards. Clicking it:

1. Spawns `claude --resume <id>` or `codex resume <id>` under AgentQuad's PTY manager
2. Marks the session as `source=adopted`

**You must close the local `claude`/`codex` process first** — two processes claiming the same session id will conflict.

## Privacy

- `redactCwd: basename` (default) sends only the directory name to IM, not the full path
- Initial prompts are truncated to 200 chars in the todo description
```

- [ ] **Step 2: 改 docs/OPENCLAW.md**

在现有 hook events 列表里补一项 `SessionStart`，加一段：

```markdown
### SessionStart (claude)

Fires on every `claude` invocation. AgentQuad uses this for:
- Auto-creating a todo card for locally-started sessions (see [LOCAL-SESSIONS.md](LOCAL-SESSIONS.md))
- Flipping aiSessions[].status to `running` for local-capture sessions

Codex has no equivalent event; codex local sessions are captured on first `UserPromptSubmit` instead.
```

- [ ] **Step 3: Commit**

```bash
git add docs/LOCAL-SESSIONS.md docs/OPENCLAW.md
git commit -m "docs: local-session auto-capture and SessionStart hook"
git push origin HEAD
```

---

## Task 17: 手测验收（全部走一遍 spec §验收标准 1-11）

**Files:** 无新增

- [ ] **Step 1: 准备环境**

```bash
npm run build:all
agentquad install claude    # 把新版 hook 装上
agentquad restart
```

- [ ] **Step 2: 逐条过验收**

| # | 验收点 | 操作 | 期待 |
|---|--------|------|------|
| 1 | claude 实时建卡 | 新 cwd 跑 `claude` | ≤2s web 端出 `[本地 claude] xxx · HH:mm` 卡，status=running |
| 2 | Phase 2 rename | 在 claude 终端输入"帮我看 X" | ≤2s 标题变 `... · "帮我看 X"` |
| 3 | 手动改 title 保护 | 步骤 1 后立即在 web 改 title | 再发 prompt 不被覆盖 |
| 4 | codex 一次到位 | 新 cwd 跑 `codex` + 发首句 | ≤2s 出带摘要的卡 |
| 5 | claude 状态切换 | 让 claude 一回合结束、触发授权弹窗、退出 | idle / pending_confirm / done 各栏正确 |
| 6 | codex 状态切换 | 跑 codex 一回合 + 退出 + 等 30min | idle → done；中间不进 pending_confirm |
| 7 | 默认路由 | 配 defaultTelegramRoute，跑 claude 一回合 | TG 收到带 cwd basename 的推送 |
| 8 | 幂等 | 同 nativeSessionId 触 5 次 hook | DB 只 1 张 |
| 9 | 跳过开关 | `AGENTQUAD_SKIP_CAPTURE=1 claude` | 不建卡，web 创建会话正常 |
| 10 | 接管 | 卡上「接管」→ 确认 → 终端关掉旧 claude | web 端出现 xterm 流，source=adopted |
| 11 | 不回归 | 用 web 端创建一个 claude 会话 | 行为跟之前一致 |

- [ ] **Step 3: 全测试套件**

```bash
npm test
```
Expected: All PASS

- [ ] **Step 4: 收尾**

把所有改动合并回 main（参考 superpowers:finishing-a-development-branch skill 或按本仓库惯例 merge）。
