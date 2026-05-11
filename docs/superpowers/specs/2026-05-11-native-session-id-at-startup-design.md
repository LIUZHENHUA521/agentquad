# Native session ID 启动即可见 + "未正常结束" 标签纠偏

**Date:** 2026-05-11
**Status:** Draft

## 背景

`feat/ai-terminal-size-first`（commit `de04f7d`）之后，新建 Claude 会话出现回归：

- 历史会话卡片里 "session id" 显示的是 quadtodo 内部 ID（`ai-{ts}-{rand}` 形式），而不是 Claude Code 的原生 UUID。
- 卡片右上同时出现 `未正常结束` 警告标签。
- 用户手动刷新页面（重新 `fetchTodos`）后，UUID 才显示出来。

期望：与 size-first handshake 之前一致——**首次渲染就是真实 Claude UUID**，运行中绝不出现 "未正常结束"。

## 现状分析

### 时序对比

| 步骤 | size-first 之前 | size-first 之后 |
|---|---|---|
| `spawnSession` 写 DB | `nativeSessionId: null`（与现在一致） | `nativeSessionId: null` |
| `pty.create()` | 不存在该函数，`start()` 直接 spawn | 只准备 `spawnSpec`，**不 spawn** |
| `pty.startWithSize()` | 与 `create()` 合一，立即 spawn | WS 收到 `init` 后才调用 |
| `native-session` emit | 同步发生在 `spawnSession` 内 | 异步发生在 WS init 之后 |
| `spawnSession` 返回 HTTP 响应 | DB 里 nativeSessionId **已就位** | DB 里 nativeSessionId **仍为 null** |
| 前端 `fetchTodos` 触发 | 看到正确 UUID | 看到 null → 显示 `ai-…-feed` + "未正常结束" |

### 关键文件 / 行号
- `src/pty.js:417-514` `create()` — 已经为新 Claude 会话预生成 `presetClaudeId`（`randomUUID()`）并把 `session.nativeId` 设进 `pty.sessions`，但没有 emit。
- `src/pty.js:583-585` `startWithSize()` — `if (session.nativeId) this.emit('native-session', …)`，emit 在此处发生。
- `src/routes/ai-terminal.js:407-420` `spawnSession` — 先以 `nativeSessionId: null` 写 DB。
- `src/routes/ai-terminal.js:219-237` `pty.on('native-session', …)` — emit 触达后才二次 patch DB。
- `web/src/TodoManage.tsx:447-455` — `!nativeSessionId` 即显示 "未正常结束" 标签，与 session 状态无关。

## 目标

1. **Claude 新会话**：`spawnSession` 返回 HTTP 响应时，DB 里该 aiSession 的 `nativeSessionId` 已经是预置 UUID；前端首次拿到的 todos 就带 UUID。
2. **Claude `--resume`**：保持现有正确行为（不回归）。
3. **"未正常结束" 标签**：只在已结束（`done` / `failed` / `stopped`）且无 nativeId 时出现；运行中或等待确认时绝不出现。
4. **Codex 新会话**：不在本次范围内——codex CLI 无 `--session-id` 预置能力，仍需 fs 探测后才能拿到 nativeId。Telegram/Lark 卡片的命名/复用都不依赖此处的首屏 UUID，可以维持现状。

## 方案 A：spawnSession 读取 pty 预置 nativeId 后再写 DB

### PtyManager 增加 getter

新增公开方法（避免外部直接戳 `pty.sessions`）：

```js
// src/pty.js
getNativeId(sessionId) {
  return this.sessions.get(sessionId)?.nativeId || null
}
```

`create()` 现有逻辑不动 — `session.nativeId` 在 `create()` 末尾就已经被赋值为 `presetClaudeId || resumeNativeId || null`。

### spawnSession 调整写 DB 顺序

`src/routes/ai-terminal.js:spawnSession` 改成 **先 `pty.create` 再 `db.updateTodo`**，并把 `db.updateTodo` 调用一起**移进现有的 `try { … } catch` 块内**（目前该 try 只包了 `pty.create` + `spawnFallbackTimer`，第 422–467 行）。调整后的顺序：

```js
sessions.set(sessionId, session)
todoSessionMap.set(todoId, sessionId)
if (resumeNativeId) nativeSessionMap.set(`${tool}:${resumeNativeId}`, sessionId)

// 注意：db.updateTodo 不再在这里调用（搬进下面的 try）

try {
  const autoEnv = { QUADTODO_SESSION_ID: sessionId, QUADTODO_TODO_ID: String(todoId), QUADTODO_TODO_TITLE: String(todo.title || '') }

  // 1. 先 pty.create 让 PtyManager 把 presetClaudeId 准备好
  pty.create({ sessionId, todoId, tool,
               prompt: resumeNativeId ? null : prompt,
               cwd: sessionCwd,
               resumeNativeId: resumeNativeId || undefined,
               permissionMode: permissionMode || null,
               extraEnv: { ...(extraEnv || {}), ...autoEnv } })

  // 2. 读出 preset nativeId（claude 新会话 = randomUUID, resume = resumeNativeId, codex 新 = null）
  const presetNativeId = pty.getNativeId(sessionId)
  session.nativeSessionId = presetNativeId  // in-memory route session 同步
  if (presetNativeId && !resumeNativeId) {
    nativeSessionMap.set(`${tool}:${presetNativeId}`, sessionId)
  }

  // 3. 一次性把 nativeSessionId 写进 DB
  db.updateTodo(todoId, {
    status: 'ai_running',
    aiSessions: mergeTodoAiSessions(todo, {
      sessionId, tool,
      nativeSessionId: presetNativeId,
      cwd: sessionCwd, status: 'running',
      startedAt: session.startedAt, completedAt: null, prompt,
      ...(label ? { label } : {}),
    }),
  })

  // 4. 5s fallback timer：现有逻辑不变
  session.spawnFallbackTimer = setTimeout(() => { … }, 5000)
  session.spawnFallbackTimer.unref?.()
} catch (error) {
  // 现有 cleanup（sessions/todoSessionMap/nativeSessionMap）保持；
  // 由于 db.updateTodo 现在也在 try 内，如果它失败，DB 还没被写脏，无需回滚。
  // 如果 pty.create 之后步骤抛错，需要追加 pty.stop?.(sessionId) 把 spawnSpec 清掉。
  sessions.delete(sessionId)
  if (todoSessionMap.get(todoId) === sessionId) todoSessionMap.delete(todoId)
  if (resumeNativeId) {
    const nativeKey = `${tool}:${resumeNativeId}`
    if (nativeSessionMap.get(nativeKey) === sessionId) nativeSessionMap.delete(nativeKey)
  }
  try { if (pty.has?.(sessionId)) pty.stop?.(sessionId) } catch { /* ignore */ }
  throw error
}
```

变化点说明：
- `db.updateTodo` 从 try 之外搬进 try 之内 —— 失败时不留脏 DB。
- catch 追加 `pty.stop?.(sessionId)` —— 覆盖 "pty.create 已建好 spawnSpec、后续步骤抛错" 这条之前漏掉的清理路径（顺手补的小修，不超出目标）。
- nativeSessionMap 写入条件 `presetNativeId && !resumeNativeId` —— resume 路径上面已经 set 过，不需要重复。

`pty.on('native-session', …)` 监听器**保留不动**：

- 对 Claude 新会话来说，`startWithSize` 还是会再次 emit；handler 会 idempotently 设置同样的值——nativeSessionMap 已有同样的映射，`mergeTodoAiSessions` 也是同值无变化。无害。
- 对 Codex 新会话来说，这是唯一的 nativeId 落库路径，必须保留。

### "未正常结束" 标签条件收紧

`web/src/TodoManage.tsx:450` 当前：

```tsx
{!nativeSessionId && (<Tooltip …><Tag>未正常结束</Tag></Tooltip>)}
```

改成：

```tsx
{!nativeSessionId && isTerminalStatus(session.status) && (
  <Tooltip …><Tag>未正常结束</Tag></Tooltip>
)}
```

其中 `isTerminalStatus(s)` 返回 `s === 'done' || s === 'failed' || s === 'stopped'`（即不包含 `running` 与 `pending_confirm`）。可以就近定义为模块顶层的 `const TERMINAL_AI_STATUSES = new Set([...])`。

这样 Codex 新会话在 fs 探测命中前的几百 ms，也不会再误显示标签。

## 数据流改变后的时序

```
[POST /api/ai-terminal/exec]
  spawnSession(...)
    sessions.set(sessionId, {...nativeSessionId: resumeNativeId || null...})
    pty.create(sessionId, ...)        ← session.nativeId = presetClaudeId（同步赋值）
    presetNativeId = pty.getNativeId(sessionId)
    session.nativeSessionId = presetNativeId
    db.updateTodo(... aiSessions [{ nativeSessionId: presetNativeId, ... }] ...)
  return { sessionId }                ← DB 已包含 nativeSessionId
[HTTP 200 → 前端 fetchTodos → UI 显示真实 UUID]

…WS init 之后：
  pty.startWithSize → emit native-session
  ai-terminal handler 二次写 DB（同值，无副作用）
```

## 验收标准

1. **首屏即正确**：触发新 Claude 会话后，**首次** `fetchTodos` 返回的 `todo.aiSessions[i].nativeSessionId` 即为合法 UUID（`/^[0-9a-f-]{36}$/`）。
2. **运行中无误报**：Claude/Codex 任一新会话在 `status === 'running'` 期间，前端历史卡片均不显示 "未正常结束" 标签。
3. **resume 行为不变**：Claude `--resume <uuid>` 新会话首屏 nativeSessionId 仍是传入的 UUID。
4. **Codex 新会话**：nativeSessionId 在 fs 探测命中后才出现（与现状相同），但 "未正常结束" 标签在 running 期间不出现。
5. **回归**：现有 vitest 全绿；针对 `spawnSession` 增加 1 个单测：`spawnSession({tool: 'claude', ...})` 调用后，`db.getTodo(todoId).aiSessions[0].nativeSessionId` 为非空 UUID。
6. **手动验证**：起一个新 Claude 会话，不刷新页面即能看到 UUID 与可复制按钮；停止该会话后才出现 "未正常结束" 标签（如果没有正常退出）。

## 范围与非目标

**在范围内**：
- `src/pty.js`：新增 `getNativeId(sessionId)`。
- `src/routes/ai-terminal.js`：`spawnSession` 写 DB 顺序与字段调整。
- `web/src/TodoManage.tsx`：标签判定收紧。
- 单测：spawnSession 路径覆盖。

**不在范围内**：
- Codex 新会话首屏 nativeSessionId（协议限制）。
- 重构 `pty.on('native-session', …)` 监听链路。
- "未正常结束" 标签的文案 / 样式调整。

## 风险

| 风险 | 缓解 |
|---|---|
| `pty.create()` 失败导致 sessions 表里有了 record 但 DB 没更新 | 在现有 try/catch 内捕获后 `pty.stop(sessionId)` 清理（沿用现有错误处理形态） |
| `pty.on('native-session', …)` 重复写 DB | mergeTodoAiSessions 已经按 sessionId 做合并；同值写入无副作用 |
| 测试 fixture 假 pty 不实现 `getNativeId` | 在测试 PtyManager mock 里加上 getter 即可 |
