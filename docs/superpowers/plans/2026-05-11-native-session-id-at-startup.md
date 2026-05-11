# Native session ID 启动即可见 + "未正常结束" 标签纠偏 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让新建 Claude 会话的历史卡片在首屏就显示真实 Claude UUID，并把"未正常结束"标签限定在已结束状态。

**Architecture:** 给 `PtyManager` 加 `getNativeId(sessionId)` getter；在 `ai-terminal` 路由的 `spawnSession` 里先 `pty.create()`、读出预置 nativeId，再一次性把 nativeSessionId 写进 DB（移进现有 try）。前端 `TodoManage.tsx` 把标签条件收紧为"无 nativeId 且处于 done/failed/stopped"。

**Tech Stack:** Node 20 ESM, Express, vitest 2.x, supertest, React 18, TypeScript, antd, zustand。

**Spec:** `docs/superpowers/specs/2026-05-11-native-session-id-at-startup-design.md`

**Branch context:** 当前在 `fix/transcript-preview-sidechain`（与用户确认沿用）。所有 commit 应该只包含本任务的改动；千万**不要 `git add .` 或 `git add -A`**——按 Files 区列出的精确路径 `git add`。

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/pty.js` | Modify | 新增 `getNativeId(sessionId)` getter（其他逻辑不动） |
| `src/routes/ai-terminal.js` | Modify | `spawnSession` 内重排 pty.create 与 db.updateTodo 顺序，把 preset nativeId 一次性写入 |
| `web/src/TodoManage.tsx` | Modify | 把 "未正常结束" 标签条件收紧 |
| `test/pty.test.js` | Modify | 为 `getNativeId` 加测试 |
| `test/ai-terminal.route.test.js` | Modify | FakePty 加 `getNativeId`；新增 spawnSession DB 状态断言 |

---

## Task 1: 给 PtyManager 加 `getNativeId(sessionId)` getter

**Files:**
- Modify: `src/pty.js` (公开方法新增点：现有 `has(sessionId)` / `list()` 周围，约第 374-380 行)
- Test: `test/pty.test.js`

**先看 spec 与现有代码上下文：**
- `src/pty.js:497` 在 `create()` 末尾已有 `nativeId: resumeNativeId || presetClaudeId || presetCursorId || null` 赋值，所以 `getNativeId` 只是读取。
- `src/pty.js:374-376` 已有 `has(sessionId)` 模板可以照着加。
- `test/pty.test.js` 用真实 `PtyManager` + `ptyFactory` mock。

- [ ] **Step 1: 看一眼现有测试结构以便对齐风格**

Run: `head -80 test/pty.test.js`
Expected: vitest `describe`/`it`，import `PtyManager from '../src/pty.js'`。记住该文件用的 ptyFactory mock 形态。

- [ ] **Step 2: 写失败测试（claude 新会话 preset id 可见）**

把以下测试块追加到 `test/pty.test.js` 最末（在最外层 `describe` 内）。如果有合适的子 `describe`（如 'native id detection'），放进去更好——否则新建一个：

```js
describe('PtyManager.getNativeId', () => {
  it('returns preset claude native id immediately after create() (before startWithSize)', () => {
    const tools = { claude: { bin: '/bin/sh', args: [] } }
    let _onData, _onExit
    const ptyFactory = () => ({
      onData: (fn) => { _onData = fn },
      onExit: (fn) => { _onExit = fn },
      resize: () => {},
      kill: () => {},
      write: () => {},
      pid: 12345,
    })
    const mgr = new PtyManager({ tools, ptyFactory })
    mgr.create({ sessionId: 'ai-test-1', tool: 'claude', prompt: 'hi', cwd: process.cwd() })
    const id = mgr.getNativeId('ai-test-1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // 触摸一下未使用变量，避免 lint
    void _onData; void _onExit
  })

  it('returns resumeNativeId for resume sessions', () => {
    const tools = { claude: { bin: '/bin/sh', args: [] } }
    const ptyFactory = () => ({ onData: () => {}, onExit: () => {}, resize: () => {}, kill: () => {}, write: () => {}, pid: 1 })
    const mgr = new PtyManager({ tools, ptyFactory })
    mgr.create({
      sessionId: 'ai-test-2',
      tool: 'claude',
      prompt: null,
      cwd: process.cwd(),
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
    expect(mgr.getNativeId('ai-test-2')).toBe('abcdef12-3456-7890-abcd-ef1234567890')
  })

  it('returns null for codex new session (no preset)', () => {
    const tools = { codex: { bin: '/bin/sh', args: [] } }
    const ptyFactory = () => ({ onData: () => {}, onExit: () => {}, resize: () => {}, kill: () => {}, write: () => {}, pid: 1 })
    const mgr = new PtyManager({ tools, ptyFactory })
    mgr.create({ sessionId: 'ai-test-3', tool: 'codex', prompt: 'hi', cwd: process.cwd() })
    expect(mgr.getNativeId('ai-test-3')).toBe(null)
  })

  it('returns null for unknown sessionId', () => {
    const tools = { claude: { bin: '/bin/sh', args: [] } }
    const mgr = new PtyManager({ tools, ptyFactory: () => ({ onData: () => {}, onExit: () => {}, resize: () => {}, kill: () => {}, write: () => {}, pid: 1 }) })
    expect(mgr.getNativeId('does-not-exist')).toBe(null)
  })
})
```

> 注意：测试构造 PtyManager 时若现有 fixture（例如 `makePtyManager()` 辅助函数）已有更简洁的写法，**用现有的**——上面的 inline 构造只是兜底示范。先 `grep -n "new PtyManager" test/pty.test.js` 确认。

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run test/pty.test.js -t "PtyManager.getNativeId"`
Expected: 4 个测试都 FAIL，原因 `mgr.getNativeId is not a function`。

- [ ] **Step 4: 实现 getter**

编辑 `src/pty.js`，在 `has(sessionId)` 方法附近（约第 374 行后）加：

```js
has(sessionId) {
  return this.sessions.has(sessionId)
}

list() {
  return [...this.sessions.keys()]
}

/** 返回 session 已知的 native id（claude 预置 / resume 沿用）；codex 新会话探测前为 null。 */
getNativeId(sessionId) {
  return this.sessions.get(sessionId)?.nativeId || null
}
```

只新增 `getNativeId`；不动 `has` / `list`。

- [ ] **Step 5: 再跑测试，确认通过**

Run: `npx vitest run test/pty.test.js -t "PtyManager.getNativeId"`
Expected: 4 PASS。

- [ ] **Step 6: 跑整个 pty 测试套确认无回归**

Run: `npx vitest run test/pty.test.js`
Expected: 所有原有测试仍 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/pty.js test/pty.test.js
git commit -m "feat(pty): expose getNativeId for early read of preset claude id"
```

---

## Task 2: FakePty 加 `getNativeId` + 验证 spawnSession 当前 DB 首次写入是 null（红测）

**Files:**
- Modify: `test/ai-terminal.route.test.js`
- Test: 同上

**目的：** 准备好测试基础设施（FakePty 模拟真实 pty 的 `getNativeId`），并先写一条**当前应当失败**的测试，证明回归确实存在。

- [ ] **Step 1: 给 FakePty 加 `getNativeId` 模拟**

编辑 `test/ai-terminal.route.test.js`，找到 `class FakePty extends EventEmitter`（约第 13-46 行）。

在 constructor 里 `this._has = new Set()` 之后增加：
```js
this._nativeIds = new Map() // sessionId → nativeId
```

在 `create(opts)` 方法体内（紧跟 `this._has.add(opts.sessionId)` 之后）增加：
```js
// 真实 PtyManager 行为：claude 新会话预置 UUID；resume 沿用；codex 新会话留 null。
if (opts.resumeNativeId) {
  this._nativeIds.set(opts.sessionId, opts.resumeNativeId)
} else if (opts.tool === 'claude') {
  this._nativeIds.set(opts.sessionId, `claude-preset-${this.created.length}`)
} else {
  this._nativeIds.set(opts.sessionId, null)
}
```

在 `stop(id)` 之后、`has(id)` 之前增加：
```js
getNativeId(id) { return this._nativeIds.get(id) ?? null }
```

> 用固定形式 `claude-preset-N` 而非 UUID，是为了让断言可预测；测试只关心"非空且与 tool/resume 对应"。

- [ ] **Step 2: 写一条新测试断言新 claude 会话 first DB write 已带 nativeSessionId**

在 `describe('routes/ai-terminal', ...)` 内（建议放在已有 `'POST /exec starts a pty and updates todo'` 测试后面）追加：

```js
it('POST /exec persists preset nativeSessionId for new claude session before HTTP response returns', async () => {
  const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
  const r = await request(ctx.app)
    .post('/api/ai-terminal/exec')
    .send({ todoId: todo.id, prompt: 'hello', tool: 'claude' })
  expect(r.status).toBe(200)
  // 这里关键：HTTP 响应返回的同一刻，DB 已经能查到 nativeSessionId（不再为 null）。
  // 不主动 emit('native-session'); 模拟"前端 WS 还没 init"。
  const updated = ctx.db.getTodo(todo.id)
  expect(updated.aiSessions).toHaveLength(1)
  expect(updated.aiSessions[0].nativeSessionId).toBeTruthy()
  expect(updated.aiSessions[0].nativeSessionId).toMatch(/^claude-preset-/)
})

it('POST /exec persists resumeNativeId immediately for claude resume', async () => {
  const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
  const r = await request(ctx.app)
    .post('/api/ai-terminal/exec')
    .send({
      todoId: todo.id,
      prompt: 'resume me',
      tool: 'claude',
      resumeNativeId: 'abcdef12-3456-7890-abcd-ef1234567890',
    })
  expect(r.status).toBe(200)
  const updated = ctx.db.getTodo(todo.id)
  expect(updated.aiSessions[0].nativeSessionId).toBe('abcdef12-3456-7890-abcd-ef1234567890')
})

it('POST /exec leaves nativeSessionId null for new codex session (no preset)', async () => {
  const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
  const r = await request(ctx.app)
    .post('/api/ai-terminal/exec')
    .send({ todoId: todo.id, prompt: 'hi', tool: 'codex' })
  expect(r.status).toBe(200)
  const updated = ctx.db.getTodo(todo.id)
  expect(updated.aiSessions[0].nativeSessionId).toBeNull()
})
```

- [ ] **Step 3: 跑这三条测试，确认前两条 FAIL（codex 那条 PASS）**

Run: `npx vitest run test/ai-terminal.route.test.js -t "persists preset nativeSessionId|persists resumeNativeId immediately|leaves nativeSessionId null"`
Expected:
- "persists preset nativeSessionId ..." → FAIL（当前 DB 里 nativeSessionId 是 null）
- "persists resumeNativeId immediately ..." → 可能 PASS（现有代码 `spawnSession` line 412 已写入 `resumeNativeId || null`），但保留它作为回归护栏。
- "leaves nativeSessionId null for new codex session" → PASS（确认范围之外的行为不变）。

> 如果"resume"那条意外失败，先停下来报告——可能我对现状有误判。

- [ ] **Step 4: 跑现有全部 ai-terminal 测试，确认 FakePty 改动没破坏老用例**

Run: `npx vitest run test/ai-terminal.route.test.js`
Expected: 老测试全 PASS；唯一红的是 Step 3 那条新增的 "persists preset nativeSessionId" 测试。

- [ ] **Step 5: Commit**

```bash
git add test/ai-terminal.route.test.js
git commit -m "test(ai-terminal): assert preset nativeSessionId is on DB after spawn"
```

---

## Task 3: 重排 `spawnSession`，让 preset nativeId 进入首次 DB 写

**Files:**
- Modify: `src/routes/ai-terminal.js` (约第 379-477 行，`spawnSession` 函数体内 `sessions.set` 到 `return { sessionId, reused: false }` 之间)

**改动要点：**
- 把 `db.updateTodo({...})` 从 try 外搬进 try 内。
- 在 try 顶部先 `pty.create()`，再用 `pty.getNativeId(sessionId)` 读出 preset。
- 写 DB 时 `nativeSessionId: presetNativeId`（取代原来的 `resumeNativeId || null`）。
- catch 块追加 `pty.stop?.(sessionId)` 兜底清理 pty 占位（避免 db.updateTodo / setTimeout 抛错后 pty 漏清）。

- [ ] **Step 1: 重新看现有代码（关键定位）**

Run: `sed -n '378,478p' src/routes/ai-terminal.js`
Expected: 看到 `const session = { ... }`，`sessions.set(...)`，`db.updateTodo(...)`，`try { pty.create ... } catch { ... }`，`return { sessionId, reused: false }`。

- [ ] **Step 2: 编辑 spawnSession 函数**

打开 `src/routes/ai-terminal.js`，找到 `spawnSession` 中以下段落（约第 407-467 行）：

```js
db.updateTodo(todoId, {
  status: 'ai_running',
  aiSessions: mergeTodoAiSessions(todo, {
    sessionId,
    tool,
    nativeSessionId: resumeNativeId || null,
    cwd: sessionCwd,
    status: 'running',
    startedAt: session.startedAt,
    completedAt: null,
    prompt,
    ...(label ? { label } : {}),
  }),
})

try {
  // 自动注入 QUADTODO_* env ...（中间注释保持原样）
  const autoEnv = {
    QUADTODO_SESSION_ID: sessionId,
    QUADTODO_TODO_ID: String(todoId),
    QUADTODO_TODO_TITLE: String(todo.title || ''),
  }
  pty.create({
    sessionId,
    todoId,
    tool,
    prompt: resumeNativeId ? null : prompt,
    cwd: sessionCwd,
    resumeNativeId: resumeNativeId || undefined,
    permissionMode: permissionMode || null,
    extraEnv: { ...(extraEnv || {}), ...autoEnv },
  })
  // 5s 兜底 ...
  session.spawnFallbackTimer = setTimeout(() => {
    session.spawnFallbackTimer = null
    if (session.spawned) return
    console.warn(`[ai-terminal] spawn fallback fired session=${sessionId} (no init within 5s)`)
    try {
      pty.startWithSize(sessionId, 80, 24)
      session.spawned = true
    } catch (e) {
      console.warn(`[ai-terminal] spawn fallback failed: ${e.message}`)
    }
  }, 5000)
  session.spawnFallbackTimer.unref?.()
} catch (error) {
  sessions.delete(sessionId)
  if (todoSessionMap.get(todoId) === sessionId) todoSessionMap.delete(todoId)
  if (resumeNativeId) {
    const nativeKey = `${tool}:${resumeNativeId}`
    if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
  }
  throw error
}
```

整体替换为：

```js
try {
  // 自动注入 QUADTODO_* env，让 ~/.quadtodo/claude-hooks/notify.js 能识别这是
  // quadtodo 启的 Claude Code → Stop / SessionEnd 事件回推到 quadtodo /api/openclaw/hook。
  // 之前只有 wizard.finalize 会显式传 extraEnv，web/CLI 直接 spawn 的 session 由于缺这些
  // env，hook 脚本 exit 0 → 完成时不推 telegram。caller-supplied 排前面，自动 env 后置覆盖
  // 防止 caller 传错的 sessionId。
  const autoEnv = {
    QUADTODO_SESSION_ID: sessionId,
    QUADTODO_TODO_ID: String(todoId),
    QUADTODO_TODO_TITLE: String(todo.title || ''),
  }
  // 1. 先 pty.create 让 PtyManager 把 presetClaudeId / resumeNativeId 落进 session 记录。
  pty.create({
    sessionId,
    todoId,
    tool,
    prompt: resumeNativeId ? null : prompt,
    cwd: sessionCwd,
    resumeNativeId: resumeNativeId || undefined,
    permissionMode: permissionMode || null,
    extraEnv: { ...(extraEnv || {}), ...autoEnv },
  })
  // 2. 读出 preset nativeId（claude 新会话 = randomUUID, resume = resumeNativeId, codex 新 = null）。
  //    这是让"首屏即正确"成立的核心：先于 db.updateTodo 拿到值。
  const presetNativeId = pty.getNativeId?.(sessionId) ?? null
  session.nativeSessionId = presetNativeId
  if (presetNativeId && !resumeNativeId) {
    // resume 路径上面已经 set 过；新会话首次得到 nativeId 时补一次。
    nativeSessionMap.set(`${tool}:${presetNativeId}`, sessionId)
  }
  // 3. 一次性把 nativeSessionId 写进 DB（搬进 try 内：失败时不留脏 DB）。
  db.updateTodo(todoId, {
    status: 'ai_running',
    aiSessions: mergeTodoAiSessions(todo, {
      sessionId,
      tool,
      nativeSessionId: presetNativeId,
      cwd: sessionCwd,
      status: 'running',
      startedAt: session.startedAt,
      completedAt: null,
      prompt,
      ...(label ? { label } : {}),
    }),
  })
  // 4. 5s 兜底：前端如果一直没发合法 init（极少见 — /exec 返回后 WS 还没连上），
  // 用老的 80×24 兜底 spawn，避免 session 永远卡在 create 状态。
  session.spawnFallbackTimer = setTimeout(() => {
    session.spawnFallbackTimer = null
    if (session.spawned) return
    console.warn(`[ai-terminal] spawn fallback fired session=${sessionId} (no init within 5s)`)
    try {
      pty.startWithSize(sessionId, 80, 24)
      session.spawned = true
    } catch (e) {
      console.warn(`[ai-terminal] spawn fallback failed: ${e.message}`)
    }
  }, 5000)
  session.spawnFallbackTimer.unref?.()
} catch (error) {
  sessions.delete(sessionId)
  if (todoSessionMap.get(todoId) === sessionId) todoSessionMap.delete(todoId)
  if (resumeNativeId) {
    const nativeKey = `${tool}:${resumeNativeId}`
    if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
  }
  // 顺手补：如果 pty.create 已经把 session 占位写进 pty.sessions、但后续步骤抛错，要清掉。
  try { if (pty.has?.(sessionId)) pty.stop?.(sessionId) } catch { /* ignore */ }
  throw error
}
```

> 这次替换覆盖**整段** 407-467 行（含外部的 `db.updateTodo` 与原 try-catch）。原 try 外的 `db.updateTodo` 被搬进新的 try 内，不要再保留旧的那一份。

- [ ] **Step 3: 跑 Task 2 引入的新测试，应当转 GREEN**

Run: `npx vitest run test/ai-terminal.route.test.js -t "persists preset nativeSessionId|persists resumeNativeId immediately|leaves nativeSessionId null"`
Expected: 3 条全 PASS。

- [ ] **Step 4: 跑整套 ai-terminal route 测试**

Run: `npx vitest run test/ai-terminal.route.test.js`
Expected: 所有测试 PASS。

> 重点关注：第 188 行 `'native-session event saves nativeSessionId on todo'`——它先 POST /exec、再 `pty.emit('native-session')`、再断言 nativeSessionId。改动后这条测试的"emit 后 DB 是 abcdef..."依然成立（因为 emit handler 会覆盖 preset，FakePty.emit 我们没改）。如果它失败：检查 emit handler 是否还在跑（应该还在）。
>
> 同样关注第 200/272 行的 resume 用例——`pty.created` 数量、`reused` 路径都不受影响。

- [ ] **Step 5: 跑全部测试（catch 回归）**

Run: `npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/routes/ai-terminal.js
git commit -m "fix(ai-terminal): persist preset nativeSessionId on first DB write"
```

---

## Task 4: "未正常结束" 标签条件收紧（前端）

**Files:**
- Modify: `web/src/TodoManage.tsx` (约第 449-455 行)

**目的：** 当前 `!nativeSessionId` 就显示 "未正常结束"，会让 running 期间（codex fs 探测尚未命中、或任何 emit 还没到）误亮。改成只在已结束状态显示。

> 这一文件没有 React 组件测试。改动是局部 JSX 条件，依赖手动验证 + 类型检查。

- [ ] **Step 1: 看现有上下文**

Run: `sed -n '447,460p' web/src/TodoManage.tsx`
Expected: 看到

```tsx
<div className="todo-history-native-id" title={nativeSessionId || session.sessionId}>
  session id: {nativeSessionId || session.sessionId}
  {!nativeSessionId && (
    <Tooltip title="该会话未正常结束...">
      <Tag color="warning" style={{ marginLeft: 6 }}>未正常结束</Tag>
    </Tooltip>
  )}
</div>
```

- [ ] **Step 2: 在文件顶部（其他模块常量附近）新增终态集合**

定位 `TodoManage.tsx` 顶部 import 段之后、第一个 React 组件之前的空白处。如果已有类似的全模块常量（例如 `DOCK_STATUS_TIP`），就紧贴它放。新增：

```ts
// AI session 的"已结束"状态——只在这些状态下显示"未正常结束"标签，
// 避免 running / pending_confirm 期间因为 nativeId 还没到位而误报。
const TERMINAL_AI_STATUSES = new Set<string>(['done', 'failed', 'stopped'])
```

> 不在 `api.ts` 里 export 集合是有意为之：这是 TodoManage 的 UI 决策，不外泄到接口契约。

- [ ] **Step 3: 把标签条件加上 status 过滤**

把 `web/src/TodoManage.tsx` 中（约第 450 行）：

```tsx
{!nativeSessionId && (
  <Tooltip title="该会话未正常结束，没有拿到原生 session ID，无法 resume/fork。请在 AI 完成后在终端里按 Ctrl+D 或 /exit 正常退出。">
    <Tag color="warning" style={{ marginLeft: 6 }}>未正常结束</Tag>
  </Tooltip>
)}
```

改成：

```tsx
{!nativeSessionId && TERMINAL_AI_STATUSES.has(session.status) && (
  <Tooltip title="该会话未正常结束，没有拿到原生 session ID，无法 resume/fork。请在 AI 完成后在终端里按 Ctrl+D 或 /exit 正常退出。">
    <Tag color="warning" style={{ marginLeft: 6 }}>未正常结束</Tag>
  </Tooltip>
)}
```

注意 `session` 是 `historySessions.map((session) => { ... })` 的迭代变量（同一段内的 `const nativeSessionId = session.nativeSessionId || ''` 即来自它）。它的类型来自 `Todo['aiSessions'][number]`，含 `status` 字段。如果 TS 报 `session.status` 是宽类型，可以临时断言：`TERMINAL_AI_STATUSES.has(String(session.status))`。

- [ ] **Step 4: 类型检查 / 构建**

```bash
cd web && npm run typecheck 2>&1 | head -40
```

Expected: 无报错。

> 如果项目根目录里没有 `npm run typecheck` 脚本，改用：`npx tsc --noEmit -p web/tsconfig.json` 或仓库的等效命令。先 `cat web/package.json | head -40` 看一下脚本名。

- [ ] **Step 5: 手动验证（启动 dev server）**

```bash
npm run dev  # 或仓库的 dev 启动命令
```

打开浏览器：
1. 新建任一 Todo，点 "AI 终端" 选 Claude，提交。
2. 看历史会话卡片 —— 应该立刻显示 Claude UUID（`xxxxxxxx-xxxx-...` 形式），**没有** "未正常结束" 标签。
3. 同样测试 Codex 新会话：首屏 nativeSessionId 可能短暂为 quadtodo 内部 ID（`ai-xxx-yyyy`），但**不应**显示 "未正常结束" 标签（因为状态是 running）。
4. 让 Claude session 异常退出（直接 kill 终端进程，模拟 crash）→ 当 nativeSessionId 已正常采到时不显示标签；但如果是真的没采到 + 状态终态，就显示标签——预期符合。

把验证结果在 commit message / PR 里复述。

- [ ] **Step 6: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "fix(web): only show '未正常结束' tag for terminal AI statuses"
```

---

## Task 5: 整合验证 + （可选）写一条端到端断言

**Files:**
- 不创建文件
- Run: 全套测试 + 手动确认

- [ ] **Step 1: 跑全部后端测试**

Run: `npx vitest run`
Expected: 全 PASS（无回归）。

- [ ] **Step 2: 跑前端类型检查 / lint**

Run: `cd web && npm run typecheck` （以及 `npm run lint` 若存在）
Expected: 全 PASS。

- [ ] **Step 3: 手动用户故事重演**

按 spec 验收条目逐条勾对：

1. **首屏即正确** — 新 Claude 会话：刷新前历史卡片 session id 显示 UUID（不是 `ai-{ts}-{rand}`）。
2. **运行中无误报** — Claude / Codex 任一新会话 running 期间均无 "未正常结束" 标签。
3. **resume 行为不变** — Claude `--resume <uuid>`：首屏即正确显示 `<uuid>`，重启工具仍能续上。
4. **Codex 新会话 nativeSessionId** 仍在 fs 探测命中后才出现（未做改进，spec 已声明范围外）。
5. **回归测试**：`npx vitest run` 全绿。

- [ ] **Step 4: 报告完成情况**

整理一段简短说明：
- 改了哪些文件 + commit hash 列表
- 哪些手动验证通过 / 哪些只通过自动测试
- 仍需用户拍板的事项（如果有）

无需 git push；交给用户审核。

---

## 备注：不在范围内的工作（明确划清）

- **Codex 新会话首屏 UUID 显示** — codex CLI 不支持 `--session-id` 预置；维持现状（首屏 null → fs 探测命中后补）。
- **`pty.on('native-session', …)` 监听链路** 不动 —— 改动后该 listener 对 claude 新会话还是会再次 emit 同值，是幂等的无害冗余；对 codex 仍是唯一落库路径。
- **"未正常结束" 标签的文案/样式** 不动。
- **rebase / 拆开历史 commit** —— 由用户决定，本计划不处理。
