# Close Terminal on Done + Remove Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Auto-kill the Claude/Codex PTY sessions started by a todo when the user marks that todo as `done`; (2) Delete the Multi-agent Pipeline feature (routes, orchestrator, worktree helpers, DB tables, frontend drawer).

**Architecture:** Two parts, kept independent so each can be reverted on its own.
- Part 1 hooks into the existing `PUT /api/todos/:id` route, calls `pty.stop` for each live session of the todo (and its subtodos), uses the existing `userClosedReason` mechanism (extended) to prevent the PTY `done` event from overwriting the just-written `'done'` status. Frontend adds a `Modal.confirm` when running sessions exist.
- Part 2 removes pipeline files, schema, config, API client, and UI entry. A one-time `DROP TABLE` migration cleans the SQLite database on next boot.

**Tech Stack:** Node.js + Express + better-sqlite3 + node-pty (server); React + TypeScript + Ant Design + Vite (web).

**Spec:** `docs/superpowers/specs/2026-05-13-close-terminal-on-done-and-remove-pipeline-design.md`

---

## File Structure (changes by file)

### Part 1 — Close terminal on done

| File | Change | Responsibility after change |
|---|---|---|
| `src/db.js` | Add `listSubtodosByParent(parentId)` helper + export | Returns `[Todo]` array of children of given parent |
| `src/routes/ai-terminal.js` | Generalize line 291 `userClosedReason` check | Skip todo status overwrite when **any** close reason is set |
| `src/routes/todos.js` | Add side effect to `PUT /:id` | When `status → 'done'`: tag parent's live sessions + `pty.stop` parent's & subtodos' live sessions |
| `test/todos.route.test.js` | Add test cases | Cover: (a) stop called on transition to done, (b) parent userClosedReason tagged, (c) cascade to subtodos but no tag on subtodos, (d) no stop for unchanged status, (e) no stop when no live session |
| `web/src/TodoManage.tsx` | Modify `handleToggleDone` (line 663) | Add `Modal.confirm` when transitioning to `'done'` with at least one running/pending_confirm session |

### Part 2 — Remove Pipeline

| File | Change | Responsibility after change |
|---|---|---|
| `src/routes/pipelines.js` | Delete file | (gone) |
| `src/orchestrator.js` | Delete file | (gone) |
| `src/worktree.js` | Delete file | (gone) |
| `src/server.js` | Remove pipeline imports + wiring | No `/api/pipelines` route, no orchestrator instance |
| `src/db.js` | Delete pipeline DDL, statements, functions, exports, seed, merge-migration column. Add `DROP TABLE` migration. | No pipeline tables, no pipeline methods |
| `src/config.js` | Delete `pipeline:` default + merge | No pipeline config knobs |
| `web/src/pipeline/PipelineRunDrawer.tsx` | Delete file | (gone) |
| `web/src/api.ts` | Delete `// ─── Multi-agent Pipelines ───` section (lines 823-942) | No Pipeline types/functions |
| `web/src/TodoManage.tsx` | Remove imports (line 57-58, BranchesOutlined if unused elsewhere), pipeline state (222-228), templates fetch (229-231), `handleStartPipeline` (233-265), `useDrawerStack('pipeline', ...)` (354), detail-drawer Pipeline button (1351-1360), `<PipelineRunDrawer />` render (1669-1683) | No pipeline UI |
| `README.md` | Add cleanup note | One-liner about removed feature + `.quadtodo-worktrees/` cleanup |

---

# Part 1 — Close Terminal on Done

## Task 1: Add `db.listSubtodosByParent` helper

**Files:**
- Modify: `src/db.js` (around line 343 statements block and the `return { ... }` exports near line 1700)
- Test: `test/db.test.js`

- [ ] **Step 1: Write the failing test**

Append at the end of `test/db.test.js`:

```js
describe('listSubtodosByParent', () => {
  it('returns children with full Todo shape, ordered by sort_order', () => {
    const db = openDb(':memory:')
    const parent = db.createTodo({ title: 'P', quadrant: 1 })
    const c1 = db.createTodo({ title: 'C1', quadrant: 1, parentId: parent.id, sortOrder: 200 })
    const c2 = db.createTodo({ title: 'C2', quadrant: 1, parentId: parent.id, sortOrder: 100 })
    db.createTodo({ title: 'Unrelated', quadrant: 2 })
    const subs = db.listSubtodosByParent(parent.id)
    expect(subs).toHaveLength(2)
    expect(subs[0].id).toBe(c2.id)
    expect(subs[1].id).toBe(c1.id)
    expect(subs[0].title).toBe('C2')
  })

  it('returns empty array for parent without children', () => {
    const db = openDb(':memory:')
    const p = db.createTodo({ title: 'Solo', quadrant: 3 })
    expect(db.listSubtodosByParent(p.id)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/db.test.js -t listSubtodosByParent`
Expected: FAIL with `db.listSubtodosByParent is not a function`.

- [ ] **Step 3: Implement the helper**

In `src/db.js`, inside `openDb()`, add a function just before the final `return { raw: db, ... }` block (search for `function listTodos`). After the existing `function listTodos(...)` block, add:

```js
function listSubtodosByParent(parentId) {
  if (!parentId) return []
  const rows = db.prepare(
    `SELECT * FROM todos WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC`
  ).all(parentId)
  return rows.map(rowToTodo)
}
```

Then in the `return { ... }` object (around line 1642+), add `listSubtodosByParent,` next to `listTodos,`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/db.test.js -t listSubtodosByParent`
Expected: PASS, 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "feat(db): add listSubtodosByParent helper

Used by todos route to cascade-close subtodo PTY sessions when parent is marked done.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Generalize `userClosedReason` check in ai-terminal.js

**Files:**
- Modify: `src/routes/ai-terminal.js:291`

Currently:
```js
if (session.userClosedReason !== 'topic_closed' && !superseded) {
  updates.status = todoStatus
}
```
Change to: any non-empty close reason should skip the overwrite, so the new `'todo_marked_done'` reason works without listing every value.

- [ ] **Step 1: Make the edit**

In `src/routes/ai-terminal.js`, replace the single condition:

```js
if (session.userClosedReason !== 'topic_closed' && !superseded) {
```

with:

```js
if (!session.userClosedReason && !superseded) {
```

- [ ] **Step 2: Run existing ai-terminal route tests to make sure nothing regressed**

Run: `npx vitest run test/ai-terminal.route.test.js`
Expected: PASS (all existing tests). If a test asserts `userClosedReason === 'topic_closed'` behavior, it should still pass — the new condition is strictly more permissive but only triggered when the reason field is truthy.

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/ai-terminal.js
git commit -m "refactor(ai-terminal): generalize userClosedReason check

Any explicit close reason (topic_closed, lark_thread_closed, slash_stop, and
the upcoming todo_marked_done) should skip the PTY done handler overwriting
todo status back to 'todo'. Listing each one is brittle.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Close PTY sessions on status → done (route)

**Files:**
- Modify: `src/routes/todos.js` PUT `/:id` handler (line 62-107)
- Test: `test/todos.route.test.js`

- [ ] **Step 1: Write the failing test**

Append in `test/todos.route.test.js`, inside the `describe('routes/todos', () => { ... })` block:

```js
describe('PUT /:id auto-close PTY on done', () => {
  function makeAppWithMocks(stops) {
    const db = openDb(':memory:')
    const liveSessions = new Map() // sessionId -> session object
    const app = express()
    app.use(express.json())
    app.use('/api/todos', createTodosRouter({
      db,
      getLiveSession: (sid) => liveSessions.get(sid) || null,
      getPty: () => ({ stop: (sid) => { stops.push(sid) } }),
    }))
    return { app, db, liveSessions }
  }

  it('calls pty.stop and tags userClosedReason when status transitions to done', async () => {
    const stops = []
    const { app, db, liveSessions } = makeAppWithMocks(stops)
    const todo = db.createTodo({
      title: 'T', quadrant: 1,
      aiSessions: [{ sessionId: 'sX', tool: 'claude', nativeSessionId: null, status: 'running', startedAt: 1, completedAt: null, prompt: '' }],
    })
    const live = { status: 'running' }
    liveSessions.set('sX', live)
    const res = await request(app).put(`/api/todos/${todo.id}`).send({ status: 'done' })
    expect(res.status).toBe(200)
    expect(stops).toEqual(['sX'])
    expect(live.userClosedReason).toBe('todo_marked_done')
  })

  it('cascades to subtodo sessions but does not tag the subtodo session', async () => {
    const stops = []
    const { app, db, liveSessions } = makeAppWithMocks(stops)
    const parent = db.createTodo({
      title: 'P', quadrant: 1,
      aiSessions: [{ sessionId: 'pSess', tool: 'claude', nativeSessionId: null, status: 'running', startedAt: 1, completedAt: null, prompt: '' }],
    })
    const child = db.createTodo({
      title: 'C', quadrant: 1, parentId: parent.id,
      aiSessions: [{ sessionId: 'cSess', tool: 'codex', nativeSessionId: null, status: 'running', startedAt: 1, completedAt: null, prompt: '' }],
    })
    const liveP = { status: 'running' }
    const liveC = { status: 'running' }
    liveSessions.set('pSess', liveP)
    liveSessions.set('cSess', liveC)
    const res = await request(app).put(`/api/todos/${parent.id}`).send({ status: 'done' })
    expect(res.status).toBe(200)
    expect(stops.sort()).toEqual(['cSess', 'pSess'])
    expect(liveP.userClosedReason).toBe('todo_marked_done')
    expect(liveC.userClosedReason).toBeUndefined()
  })

  it('skips dead sessions (status done/failed/stopped)', async () => {
    const stops = []
    const { app, db, liveSessions } = makeAppWithMocks(stops)
    const todo = db.createTodo({
      title: 'T', quadrant: 1,
      aiSessions: [
        { sessionId: 'dead', tool: 'claude', nativeSessionId: null, status: 'done', startedAt: 1, completedAt: 2, prompt: '' },
        { sessionId: 'live', tool: 'claude', nativeSessionId: null, status: 'running', startedAt: 1, completedAt: null, prompt: '' },
      ],
    })
    liveSessions.set('dead', { status: 'done' })
    liveSessions.set('live', { status: 'pending_confirm' })
    await request(app).put(`/api/todos/${todo.id}`).send({ status: 'done' })
    expect(stops).toEqual(['live'])
  })

  it('does nothing when status is unchanged or moves to non-done', async () => {
    const stops = []
    const { app, db, liveSessions } = makeAppWithMocks(stops)
    const todo = db.createTodo({
      title: 'T', quadrant: 1, status: 'todo',
      aiSessions: [{ sessionId: 'sX', tool: 'claude', nativeSessionId: null, status: 'running', startedAt: 1, completedAt: null, prompt: '' }],
    })
    liveSessions.set('sX', { status: 'running' })
    await request(app).put(`/api/todos/${todo.id}`).send({ title: 'renamed' })
    await request(app).put(`/api/todos/${todo.id}`).send({ status: 'ai_running' })
    expect(stops).toEqual([])
  })

  it('does not blow up when getPty / getLiveSession is missing or session is gone', async () => {
    const db = openDb(':memory:')
    const app = express()
    app.use(express.json())
    app.use('/api/todos', createTodosRouter({ db })) // no getPty, no getLiveSession
    const todo = db.createTodo({
      title: 'T', quadrant: 1,
      aiSessions: [{ sessionId: 'sX', tool: 'claude', nativeSessionId: null, status: 'running', startedAt: 1, completedAt: null, prompt: '' }],
    })
    const res = await request(app).put(`/api/todos/${todo.id}`).send({ status: 'done' })
    expect(res.status).toBe(200)
    expect(res.body.todo.status).toBe('done')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/todos.route.test.js -t "auto-close PTY on done"`
Expected: FAIL — `stops` will be empty because the route doesn't call pty.stop yet.

- [ ] **Step 3: Implement the side effect in the route**

In `src/routes/todos.js`, modify the PUT handler. The current code (line 62-107) ends with:
```js
const todo = db.updateTodo(req.params.id, patch)
res.json({ ok: true, todo })
```
Change it to insert the cleanup before sending the response:

```js
const todo = db.updateTodo(req.params.id, patch)

// Auto-close PTY when status transitions to 'done':
// - kill all live AI sessions of this todo and its subtodos
// - tag parent's live sessions with userClosedReason so PTY 'done' handler
//   doesn't overwrite the just-written status back to 'todo'.
// - subtodo sessions are NOT tagged (subtodo lifecycle is independent;
//   normal PTY 'done' handler will reset them to 'todo' which is correct)
if (existing.status !== 'done' && patch.status === 'done') {
  const pty = typeof getPty === 'function' ? getPty() : null
  if (pty && typeof getLiveSession === 'function') {
    const parentSessions = Array.isArray(todo.aiSessions) ? todo.aiSessions : []
    for (const s of parentSessions) {
      const live = getLiveSession(s.sessionId)
      if (live && (live.status === 'running' || live.status === 'pending_confirm' || live.status === 'idle')) {
        live.userClosedReason = 'todo_marked_done'
        try { pty.stop(s.sessionId) } catch (e) { console.warn('[todos] pty.stop parent failed:', e?.message) }
      }
    }
    const subtodos = typeof db.listSubtodosByParent === 'function' ? db.listSubtodosByParent(todo.id) : []
    for (const sub of subtodos) {
      const subSessions = Array.isArray(sub.aiSessions) ? sub.aiSessions : []
      for (const s of subSessions) {
        const live = getLiveSession(s.sessionId)
        if (live && (live.status === 'running' || live.status === 'pending_confirm' || live.status === 'idle')) {
          try { pty.stop(s.sessionId) } catch (e) { console.warn('[todos] pty.stop subtodo failed:', e?.message) }
        }
      }
    }
  }
}

res.json({ ok: true, todo })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/todos.route.test.js -t "auto-close PTY on done"`
Expected: 5 tests PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: All green.

- [ ] **Step 6: Commit**

```bash
git add src/routes/todos.js test/todos.route.test.js
git commit -m "feat(todos): auto-close PTY sessions when todo marked done

PUT /api/todos/:id detects status transition to 'done' and:
- Kills live PTY sessions of the todo (Claude/Codex terminals)
- Cascades to subtodo sessions (subtodos remain status='todo', not auto-completed)
- Tags parent sessions with userClosedReason='todo_marked_done' so the PTY
  'done' event won't overwrite the new status back to 'todo'

Covers MCP / Telegram / OpenClaw entry points by hooking the route, not the UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend confirm dialog for `handleToggleDone`

**Files:**
- Modify: `web/src/TodoManage.tsx:663-671`

`Modal` is already imported (line 4). `message` already imported.

- [ ] **Step 1: Update `handleToggleDone` to confirm before marking done**

Replace lines 663-671 in `web/src/TodoManage.tsx`:

```tsx
const handleToggleDone = async (todo: Todo) => {
  const newStatus = todo.status === 'done' ? 'todo' : 'done'
  const liveCount = newStatus === 'done'
    ? (todo.aiSessions || []).filter((s) => s.status === 'running' || s.status === 'pending_confirm').length
    : 0
  const doUpdate = async () => {
    try {
      await updateTodo(todo.id, { status: newStatus })
      fetchTodos()
    } catch (e: any) {
      message.error(e?.message || '操作失败')
    }
  }
  if (liveCount > 0) {
    Modal.confirm({
      title: '该任务还有 AI 会话在运行',
      content: `共有 ${liveCount} 个 Claude/Codex 终端正在运行。标记完成会同时关闭它们。确定继续？`,
      okText: '确定，完成并关闭',
      cancelText: '取消',
      onOk: doUpdate,
    })
    return
  }
  await doUpdate()
}
```

- [ ] **Step 2: Type-check the frontend build**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Build the frontend**

Run: `npm run build`
Expected: build succeeds, no TS errors.

- [ ] **Step 4: Manual UI verification (smoke)**

Run: `agentquad start` (or `node src/cli.js start --no-open` if not globally linked).
- Open http://127.0.0.1:5677
- Create a todo, click 启动 AI 终端 (or use whatever current UI launches a Claude session)
- Wait until session status shows running
- Click the checkbox to mark the todo done
- Verify: a `Modal.confirm` appears with the message "共有 1 个 Claude/Codex 终端正在运行..."
- Click 确定：todo turns done; the mini terminal panel shows "=== AI 任务已结束 ===" within ~2s
- Repeat without a live session: clicking done should not show the modal

Document the result in your commit/PR description if any UI assumption breaks.

- [ ] **Step 5: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "feat(todo-card): confirm before marking done when AI sessions still running

When the user clicks the checkbox to mark a todo done and the todo has at
least one running/pending_confirm AI session, show Modal.confirm so the user
explicitly accepts that the running Claude/Codex terminals will be killed.

Going from done back to todo or moving to other statuses doesn't trigger the
prompt. Acceptance button ('验收通过' in detail drawer) doesn't trigger either,
since by the time status is ai_done the PTY has already exited.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Part 2 — Remove Pipeline

## Task 5: Remove pipeline backend routes & wiring

**Files:**
- Delete: `src/routes/pipelines.js`
- Delete: `src/orchestrator.js`
- Delete: `src/worktree.js`
- Modify: `src/server.js` (lines 29-30 imports, line 1140-1142 wiring)
- Modify: `src/config.js` (lines 339-341 + 434)

- [ ] **Step 1: Delete the three backend files**

```bash
rm src/routes/pipelines.js src/orchestrator.js src/worktree.js
```

- [ ] **Step 2: Remove imports in `src/server.js`**

In `src/server.js`, delete:
```js
import { createPipelinesRouter } from "./routes/pipelines.js";
```
and:
```js
import { createOrchestrator } from "./orchestrator.js";
```

- [ ] **Step 3: Remove orchestrator instance + route mount in `src/server.js`**

Delete lines around 1140-1142:
```js
// Multi-agent pipeline orchestrator
const orchestrator = createOrchestrator({ db, pty, aiTerminal: ait, logDir });
app.use("/api/pipelines", createPipelinesRouter({ db, orchestrator }));
```

- [ ] **Step 4: Remove `pipeline:` default + merge in `src/config.js`**

Delete lines 339-341:
```js
pipeline: {
  maxAgents: 3,
},
```

Delete line 434:
```js
pipeline: { ...defaults.pipeline, ...(cfg.pipeline || {}) },
```

- [ ] **Step 5: Verify the server boots & API tests still pass**

Run: `npx vitest run`
Expected: All non-pipeline tests green. (If any test imports `orchestrator.js` or `pipelines.js`, deletion will surface here — none expected per the spec audit, but if it appears, delete or update that test.)

Optional smoke: `node src/cli.js start --no-open` for 2 seconds, then Ctrl+C; ensure no missing-module errors in stdout.

- [ ] **Step 6: Commit**

```bash
git add -A src/routes/pipelines.js src/orchestrator.js src/worktree.js src/server.js src/config.js
git commit -m "refactor: remove pipeline backend (routes, orchestrator, worktree)

Drop /api/pipelines route, multi-agent orchestrator, and git worktree helpers.
Pipeline config section in ~/.agentquad/config.json is ignored (no longer read).

DB schema cleanup follows in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Remove pipeline DB schema, statements, functions, exports

**Files:**
- Modify: `src/db.js`
- Modify: `src/db.js` (merge migration mention at line 580 and 622)
- Test: `test/db.test.js`

- [ ] **Step 1: Add a regression test for the DROP migration**

Append to `test/db.test.js`:

```js
describe('pipeline tables removed', () => {
  it('pipeline_runs and pipeline_templates tables do not exist after openDb', () => {
    const db = openDb(':memory:')
    const tableRow = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pipeline_runs','pipeline_templates')`
    ).all()
    expect(tableRow).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/db.test.js -t "pipeline tables removed"`
Expected: FAIL — both tables still exist.

- [ ] **Step 3: Delete the pipeline DDL in `src/db.js`**

Delete the two `CREATE TABLE` blocks at line 124 (`pipeline_templates`) and line 136 (`pipeline_runs`), and the two indexes near line 149-150. Keep `prompt_templates` (line 91) — that's unrelated.

- [ ] **Step 4: Add the one-time DROP migration**

Locate the schema bootstrap section (where the existing `CREATE TABLE IF NOT EXISTS` statements run, after `db.exec(...)` calls around line 290-320). After all `CREATE TABLE` and index statements are done, add:

```js
// Phase-out: pipeline feature removed in 2026-05-13 cleanup.
// Drop the two tables if they exist (idempotent — no-op for fresh installs).
db.exec(`DROP TABLE IF EXISTS pipeline_runs;`)
db.exec(`DROP TABLE IF EXISTS pipeline_templates;`)
```

- [ ] **Step 5: Delete pipeline statements, helpers, and seed function**

In `src/db.js`, delete:
- Lines 1448-1640: the entire `// ─── pipeline templates & runs ───` section, including `pipeTmplStmts`, `rowToPipeTemplate`, `listPipelineTemplates`, `getPipelineTemplate`, `createPipelineTemplate`, `updatePipelineTemplate`, `deletePipelineTemplate`, `pipeRunStmts`, `rowToPipeRun`, `createPipelineRun`, `updatePipelineRun`, `listPipelineRunsForTodo`, `getPipelineRun`, `listActivePipelineRuns`, `findActivePipelineRunForTodo`, `seedBuiltinPipelineTemplatesIfEmpty` + the `seedBuiltinPipelineTemplatesIfEmpty()` call at line 1640. Also delete the `CODER_SYS` and `REVIEWER_SYS` string constants inside that function.

> Note: `safeParseJson` is defined inside that section but might still be used by `rowToPipeRun` only — verify by grep. If grep shows zero remaining callers after deletion, also remove `safeParseJson`. If it has external callers, keep it.

Run: `grep -n "safeParseJson" src/db.js`
- If no matches outside the deleted region, delete the `function safeParseJson(...)` definition too.
- If matches exist elsewhere, leave `safeParseJson` alone (move it out of the deleted block to a stable location).

- [ ] **Step 6: Delete pipeline exports**

In the `return { raw: db, ... }` object near line 1700-1712, delete:
```js
// pipeline
listPipelineTemplates,
getPipelineTemplate,
createPipelineTemplate,
updatePipelineTemplate,
deletePipelineTemplate,
createPipelineRun,
updatePipelineRun,
listPipelineRunsForTodo,
getPipelineRun,
listActivePipelineRuns,
findActivePipelineRunForTodo,
```

- [ ] **Step 7: Remove pipeline_runs from the merge-todos migration**

In `src/db.js`:
- Delete line 572: `let movedPipelineRuns = 0`
- Delete line 580: `movedPipelineRuns += countOne(...)`
- Delete line 599: `movedPipelineRuns,` (inside the return object of `describeMergeTodos`)
- Delete line 622: `db.prepare('UPDATE pipeline_runs SET todo_id = ? WHERE todo_id = ?').run(targetId, src.id)`
- Update the docstring on line 606 to drop the `pipeline_runs` mention.

- [ ] **Step 8: Run the regression test**

Run: `npx vitest run test/db.test.js -t "pipeline tables removed"`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npx vitest run`
Expected: All green. If any test referenced `movedPipelineRuns` in a snapshot/assertion, update it.

- [ ] **Step 10: Commit**

```bash
git add src/db.js test/db.test.js
git commit -m "refactor(db): drop pipeline schema, statements, exports

- DROP TABLE pipeline_runs, pipeline_templates (one-time migration on boot)
- Delete pipeTmplStmts, pipeRunStmts, all related CRUD functions
- Delete seedBuiltinPipelineTemplatesIfEmpty + CODER_SYS/REVIEWER_SYS prompts
- Remove pipeline_runs column updates from mergeTodos migration path
- Add regression test guarding the tables stay dropped

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Remove pipeline frontend (api.ts + drawer file)

**Files:**
- Delete: `web/src/pipeline/PipelineRunDrawer.tsx`
- Modify: `web/src/api.ts` (delete lines 823-942 — the entire `// ─── Multi-agent Pipelines ───` section through `extendPipelineRun`)

- [ ] **Step 1: Delete the pipeline drawer**

```bash
rm -r web/src/pipeline
```
(If the `pipeline/` directory contains only `PipelineRunDrawer.tsx`, the whole dir is gone. If other files exist, list them first with `ls web/src/pipeline/` and delete the entire dir.)

- [ ] **Step 2: Delete the pipeline API section in `web/src/api.ts`**

Open `web/src/api.ts` and delete the entire region from `// ─── Multi-agent Pipelines ───` (currently around line 823) through the last pipeline function (`extendPipelineRun` ending around line 942). The next section begins with `// ─── 全局搜索（⌘K 面板 + MCP 复用同一端点） ───` and must be kept.

Specifically removing:
- Interfaces: `PipelineRoleConfig`, `PipelineEdgeRule`, `PipelineTemplate`, `PipelineAgentInstance`, `PipelineMessage`, `PipelineRun`
- Functions: `listPipelineTemplates`, `listPipelineRunsForTodo`, `getPipelineRun`, `startPipelineRun`, `stopPipelineRun`, `mergePipelineRun`, `cleanupPipelineRun`, `acceptPipelineRun`, `extendPipelineRun`

- [ ] **Step 3: Verify the frontend type-checks**

Run: `cd web && npx tsc --noEmit`
Expected: errors only in files that still reference Pipeline types (TodoManage.tsx). Those are fixed in the next task.

- [ ] **Step 4: Defer commit**

Don't commit yet — Task 8 finishes the frontend cleanup. Commit at end of Task 8.

---

## Task 8: Remove pipeline references from `TodoManage.tsx`

**Files:**
- Modify: `web/src/TodoManage.tsx`

Cleanup points (line numbers approximate, search & fix):

- [ ] **Step 1: Remove pipeline imports**

In `web/src/TodoManage.tsx`, line 57-58:
```tsx
import { getTranscriptStats, listPipelineTemplates, listPipelineRunsForTodo, startPipelineRun, PipelineTemplate, PipelineRun } from './api'
import PipelineRunDrawer from './pipeline/PipelineRunDrawer'
```
Change to:
```tsx
import { getTranscriptStats } from './api'
```
(Pipeline drawer import line is fully deleted.)

- [ ] **Step 2: Remove `BranchesOutlined` from icon imports if not used elsewhere**

Run: `grep -n "BranchesOutlined" web/src/TodoManage.tsx` to verify; if only the import line + the Pipeline button use it, remove `BranchesOutlined,` from the import on line 14.

Edit line 14:
```tsx
BookOutlined, LineChartOutlined, TrophyOutlined, BranchesOutlined,
```
→
```tsx
BookOutlined, LineChartOutlined, TrophyOutlined,
```

- [ ] **Step 3: Remove pipeline state block**

Delete lines 222-231:
```tsx
// Pipeline state
const [pipelineTemplates, setPipelineTemplates] = useState<PipelineTemplate[]>([])
const [pipelineDrawerOpen, setPipelineDrawerOpen] = useState(false)
const [pipelineActiveRun, setPipelineActiveRun] = useState<PipelineRun | null>(null)
const [pipelineActiveTemplate, setPipelineActiveTemplate] = useState<PipelineTemplate | null>(null)
const [pipelineActiveTodo, setPipelineActiveTodo] = useState<Todo | null>(null)
const [pipelineStarting, setPipelineStarting] = useState(false)
useEffect(() => {
  listPipelineTemplates().then(setPipelineTemplates).catch(() => { /* silent */ })
}, [])
```

- [ ] **Step 4: Remove `handleStartPipeline` callback**

Delete lines 233-265:
```tsx
const handleStartPipeline = useCallback(async (todo: Todo) => {
  ...
}, [pipelineTemplates])
```

- [ ] **Step 5: Remove drawer-stack registration**

Delete line 354:
```tsx
useDrawerStack('pipeline', pipelineDrawerOpen, () => setPipelineDrawerOpen(false))
```

- [ ] **Step 6: Remove Pipeline button in detail drawer**

Delete lines 1351-1360 (the entire `{detailTodo && (<Tooltip ...><Button ... onClick={() => handleStartPipeline(detailTodo)}>Pipeline</Button></Tooltip>)}` block).

- [ ] **Step 7: Remove `<PipelineRunDrawer />` render**

Delete lines 1669-1683 (the entire `<PipelineRunDrawer ... onClose={() => { ... }} />` element).

- [ ] **Step 8: Type-check the frontend**

Run: `cd web && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 9: Build the frontend**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 10: Commit Task 7 + 8 together**

```bash
git add -A web/src/pipeline web/src/api.ts web/src/TodoManage.tsx
git commit -m "refactor(web): remove pipeline UI (drawer, API client, entry button)

- Delete PipelineRunDrawer + entire web/src/pipeline directory
- Delete Pipeline* interfaces and CRUD functions from api.ts
- Strip pipeline state, handler, button, drawer, drawer-stack reg from TodoManage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: README note + final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the cleanup note**

In `README.md`, find a reasonable spot in the "故障排除" or near the top of the change-log style sections (the README mentions migration steps elsewhere — follow that pattern). Add:

```markdown
- **Multi-agent Pipeline 功能已移除**：之前的 Pipeline（coder ↔ reviewer 循环）特性已下线。升级后下次启动会自动 DROP `pipeline_runs` / `pipeline_templates` 两张表。仓库根目录里如果有遗留的 `.quadtodo-worktrees/` 目录（worktree 临时目录），可手动 `rm -rf .quadtodo-worktrees/` 清理；`.gitignore` 里的 `.quadtodo-worktrees/` 行可保留也可删除（保留无副作用）。
```

Place it in the 故障排除 section (around line 240+) or wherever feels coherent — match the existing tone.

- [ ] **Step 2: Final repo sweep for stragglers**

Run:
```bash
grep -rn "pipeline\|Pipeline" src/ web/src/ --include="*.js" --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "\.test\." | grep -v "node_modules" | grep -v "// \|/\*"
```

Expected output: only matches in docs/, specs, this plan, or incidental string content (e.g. todo titles in test fixtures). If any source file (non-test, non-doc) still references pipeline, decide whether it's a leftover and delete.

Also:
```bash
grep -rn "worktree\|Worktree" src/ web/src/ 2>/dev/null | grep -v "node_modules"
```
Expected: zero matches (or only in comments/docs).

- [ ] **Step 3: Run the full test suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 4: Run the frontend build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Boot smoke test**

Run: `node src/cli.js start --no-open --port 5688`
Wait 3 seconds. Verify stdout shows no error, then in another terminal: `curl -s http://127.0.0.1:5688/api/pipelines/templates` and expect `Cannot GET /api/pipelines/templates` (Express 404).
Stop: `node src/cli.js stop` or kill the process.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(readme): note pipeline removal + worktree cleanup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final Verification Checklist

- [ ] `npx vitest run` — all tests green
- [ ] `cd web && npm run build` — frontend build clean
- [ ] `agentquad start` boots without errors; `/api/pipelines/*` returns 404
- [ ] UI: mark a todo with a running Claude session as done → confirm modal appears → confirm → terminal panel closes within ~2s, todo stays as done (does NOT flip back to todo)
- [ ] UI: mark a todo without any AI session as done → no modal, just goes done
- [ ] UI: detail drawer no longer shows the "Pipeline" button
- [ ] DB: after first boot post-merge, `sqlite3 ~/.agentquad/data.db ".tables"` shows no `pipeline_*` tables
- [ ] grep `Pipeline\|pipeline\|worktree` in `src/` + `web/src/` matches only comments / removed-feature mentions

