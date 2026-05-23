# 本地直起 claude/codex 会话自动同步 & 默认通知

**Date**: 2026-05-23
**Status**: Draft (awaiting user review)
**Owner**: lzh

## 背景与动机

当前 AgentQuad 推送飞书/Telegram 的前提是「会话从 web 端创建」——只有这样 PTY 才挂在 AgentQuad、`todo.aiSessions[].telegramRoute/larkRoute` 才会被设置、hook 触发时才能找到匹配 todo 并发出推送。

但用户的真实工作流是直接在终端跑 `claude` 或 `codex`。这些会话当前对 AgentQuad 完全不可见：

- 现有 `src/transcripts/` 模块虽然会扫 `~/.claude/projects/*.jsonl`、`~/.codex/sessions/...` 并把 `nativeSessionId` auto-bind 到既有 todo，但**从不自动建 todo**。
- 现有 hook 通路（`openclaw-hook-installer` 装的 claude hooks、`codex-hook-installer` 装的 codex hooks）虽然能拿到 sessionId/cwd/tool，但在后端 handler 里若反查不到 todo 就会静默丢弃。

**目标**：用户在任意 cwd 直起 `claude` / `codex`，应当：

1. AgentQuad web 端自动出现对应 todo 卡片，状态 running
2. 该 todo 自动套上 config 中配置的默认 telegram/飞书路由
3. web 端提供「接管」按钮，把会话从用户本地 PTY 转交给 AgentQuad 管理

## 关键决策（已与用户对齐）

| # | 决策 | 选择 |
|---|------|------|
| D1 | 工具范围 | claude + codex，架构上预留 cursor 等后续扩展 |
| D2 | 新建 todo 的象限 | 不传 quadrant，db 走默认值（quadrant 概念已从 UI 退役） |
| D3 | 默认通知路由配置 | 在 `~/.agentquad/config.json` 新增 `localSessions.defaultTelegramRoute / defaultLarkRoute` |
| D4 | 触发方式 | 实时（基于 hook），不走轮询 |
| D5 | PTY 接管 | web 端单独提供「接管」按钮，默认不接管；接管前提示用户关本地 PTY |
| D6 | codex 收尾 | 接受 Stop+30min 静默超时作为 codex 的 completed 判定 |
| D7 | 默认开关 | `localSessions.autoCapture.enabled` 默认 true，配合 `AGENTQUAD_SKIP_CAPTURE` 环境变量兜底 |
| D8 | hook 升级方式 | release notes + server 启动时检查 hook 版本，前端 banner 提醒用户重跑 `agentquad install claude` |

## 架构

### 数据流

```
本地 terminal: claude / codex
       │
       ▼
 [hook event]                       (SessionStart / UserPromptSubmit / Stop / Notification / SessionEnd)
       │
       ▼
 ~/.agentquad/.../notify.js         (现有 hook 入口脚本，HTTP POST 到本地 server)
       │
       ▼
 POST /api/openclaw-hook            (src/routes/openclaw-hook.js)
       │
       ▼
 openclaw-hook.js handler           (src/openclaw-hook.js)
       │
       ├── 1. 反查 todo by nativeSessionId
       │
       ├── 2a. 找到 → 走原 telegram/lark 推送链路（不变）
       │
       └── 2b. 找不到 + autoCapture.enabled + 未设置 AGENTQUAD_SKIP_CAPTURE
                │
                ▼
              auto-create todo                (新逻辑，本设计核心)
                │ - title: [本地 ${tool}] ${cwd basename} @ HH:mm
                │ - work_dir: cwd
                │ - aiSessions[0]: { nativeSessionId, source: 'local-capture',
                │                     telegramRoute / larkRoute: from config defaults }
                ▼
              再走 telegram/lark 推送链路（现在能找到 todo）
```

### 组件边界

| 模块 | 责任 | 新增/改动 |
|------|------|-----------|
| `src/openclaw-hook-installer.js` | 维护 claude `~/.claude.json` 里的 hooks | **改**：`HOOK_EVENTS` 加 `SessionStart`；递增 `quadtodo-hook-version` |
| `src/codex-hook-installer.js` | 维护 codex `~/.codex/hooks.json` | 不变（codex 无 SessionStart 事件，沿用 Stop + UserPromptSubmit） |
| `src/openclaw-hook.js` | hook payload 主 handler | **改**：handler 入口加 `ensureTodoForLocalSession()` 分支 |
| `src/db.js` | DB schema + 查询 | **加**：`findTodoByNativeSessionId(nativeId)`；`createLocalCaptureTodo(payload)` 事务包装 |
| `src/config.js` | config schema + 读写 | **加**：`localSessions` 子树 + 默认值 |
| `src/routes/ai-terminal.js` | PTY spawn 接口 | **加**：`POST /adopt-local { todoId, sessionId }` |
| `web/src/...`（todo 卡片组件） | UI | **加**：source=local-capture 时显示「接管」按钮 + confirm 弹窗 |
| `docs/LOCAL-SESSIONS.md` | 文档 | **新建** |
| `docs/OPENCLAW.md` | 文档 | **改**：补一段说明 SessionStart hook |

### 数据结构

#### config.json 新增字段

```jsonc
{
  // ... 现有字段
  "localSessions": {
    "autoCapture": {
      "enabled": true,            // 总开关；false 时回退到原行为（hook 找不到 todo 就丢弃）
      "redactCwd": "basename"     // basename | full | none，控制推送到 IM 的 cwd 显示粒度
    },
    "defaultTelegramRoute": null, // null | { chatId, threadId?, ... }；结构对齐现有 telegramRoute
    "defaultLarkRoute": null,     // null | { ... }；结构对齐现有 larkRoute
    "skipEnvVar": "AGENTQUAD_SKIP_CAPTURE"  // 环境变量名，hook 检测到 process.env[这个] 非空即跳过
  }
}
```

#### todo.aiSessions[] 新字段

```js
{
  sessionId,            // 现有 — AgentQuad 内部 id
  nativeSessionId,      // 现有 — claude/codex 的 native uuid
  tool,                 // 现有 — 'claude' | 'codex'
  status,               // 现有 — 'running' | 'completed' | ...
  startedAt, completedAt,
  telegramRoute, larkRoute,
  // 新增
  source: 'local-capture' | 'adopted' | 'web'   // 默认 'web'（向后兼容：缺省视为 'web'）
}
```

`source` 字段说明：

- `web`: 现有的 web 端创建（默认值，缺省即 web）
- `local-capture`: 本地直起、由 hook 自动捕获
- `adopted`: 原本 local-capture，用户点了「接管」之后升级

## 详细行为

### A. 自动建 todo（核心）

入口：`src/openclaw-hook.js` 主 handler。在原有「反查 todo」之后插入分支：

```js
// 伪代码
async function handleHookEvent(payload) {
  const { sessionId, event, cwd, tool, ... } = normalize(payload)

  // 跳过显式 opt-out
  if (payload.env?.[config.localSessions.skipEnvVar]) {
    return originalHandle(payload, /*todo*/ null)
  }

  let todo = await db.findTodoByNativeSessionId(sessionId)

  if (!todo && config.localSessions.autoCapture.enabled && shouldCapture(event)) {
    todo = await db.createLocalCaptureTodo({
      tool,
      nativeSessionId: sessionId,
      cwd,
      initialPrompt: event === 'UserPromptSubmit' ? payload.prompt?.slice(0, 200) : null,
      eventThatCreated: event,
      defaults: config.localSessions,
    })
    // emit event so server.js 推送给 web 端列表实时刷新
    events.emit('todo-created', { todoId: todo.id, source: 'local-capture' })
  }

  return originalHandle(payload, todo)
}
```

`shouldCapture(event)` 返回 true 的事件：

- claude: `SessionStart` (推荐，1s 内可见) | `UserPromptSubmit` | `Notification` | `Stop`
- codex: `UserPromptSubmit` (首次) | `Stop`

为避免错过任何一种触发，**任意一个上述事件都能触发创建**——`createLocalCaptureTodo` 内部用 `findTodoByNativeSessionId` + 事务保证幂等。

#### `createLocalCaptureTodo` 幂等性

```js
db.transaction(() => {
  const existing = findTodoByNativeSessionId(nativeId)  // 事务内再查一次
  if (existing) return existing
  return insertTodo({...})
})()
```

sqlite better-sqlite3 的事务是同步且独占的，足以避免并发 hook 同时进来时建出两张卡。

### B. 收尾（status → completed）

| 工具 | 触发 | 处理 |
|------|------|------|
| claude | `SessionEnd` hook | handler 找到 todo → 更新 `aiSessions[i].status = 'completed'`, `completedAt = now` |
| codex | `Stop` hook（最后一次）+ 后台 30min 静默超时 | 每次 `Stop` 记录 `lastStopAt`；后台定时器（复用现有 transcript scanner 的 tick 或新起 setInterval）扫所有 source ∈ {local-capture, adopted} 且 status=running 的 codex session，若 `now - lastStopAt > 30min` 则 mark completed |

收尾不阻塞主流程；超时 mark 用现有 db update 方法。

### C. 接管按钮

#### 后端：`POST /api/ai-terminal/adopt-local`

请求：`{ todoId, sessionId }`（sessionId 是 AgentQuad 内部 id）

逻辑：

```js
const todo = db.getTodo(todoId)
const session = todo.aiSessions.find(s => s.sessionId === sessionId)
assert(session.source === 'local-capture')
assert(session.status === 'running')

// 复用现有 spawn 路径
const pty = await ptyManager.spawn({
  tool: session.tool,
  cwd: todo.work_dir,
  resumeNativeId: session.nativeSessionId,
  sessionId,                  // 复用同一个 sessionId
  todoId,
  ...
})

// 更新 source
db.updateAiSession(todoId, sessionId, { source: 'adopted' })

return { ok: true, sessionId, nativeSessionId: session.nativeSessionId }
```

`PtyManager.spawn` 现有就支持 `resumeNativeId`，命令会变成 `claude --resume <id>` / `codex resume <id>`。

#### 前端：卡片右上角按钮

- 仅当 `source === 'local-capture'` 且 `status === 'running'` 时显示
- 点击 → AntD `Modal.confirm`：
  > **接管本地会话**
  >
  > 即将通过 `claude --resume <id>` 在 AgentQuad 中接管这个会话。
  >
  > **请先在本地终端按 Ctrl+C 退出 claude/codex**，否则两个进程同时持有同一 session id 会出错。
  >
  > 确认继续？
- 确认后 POST → 成功后该卡片刷新，按钮消失（source 变 adopted），terminal 抽屉自动展开

### D. hook 升级提醒

`src/openclaw-hook-installer.js` 已有 `quadtodo-hook-version` 标记。本次改动：

1. `HOOK_EVENTS` 加 `SessionStart`
2. version 号 +1

server 启动时（`src/server.js` bootstrap 段）扫 `~/.claude.json` 当前 version vs `EXPECTED_VERSION`，若旧→在某个内部状态里记一个 flag，HTTP `GET /api/status` 返回 `hookOutdated: true`。前端读到后 topbar 渲染一个 dismissible banner：

> claude hooks 已升级，请运行 `agentquad install claude` 让本地直起的会话自动同步到 web 端 [Got it]

不强制阻断功能，让用户自行决定。

## 错误与边界

| 场景 | 处理 |
|------|------|
| hook payload 缺 cwd / tool / sessionId | 跳过 auto-create，走原流程（log 一行 warn） |
| 同 nativeSessionId 多 hook 并发 | sqlite 事务保证只建一张 |
| cwd 不存在 / 无读权限 | 不阻断，正常建 todo（work_dir 字段允许任意字符串） |
| autoCapture.enabled = false | 完全回退到原行为，本设计的 handler 改动相当于 no-op |
| defaultTelegramRoute / defaultLarkRoute 都 null | todo 仍会建，只是不挂通知 |
| 用户手动 archive / delete 自动建出来的 todo | 跟普通 todo 一致；后续同 nativeSessionId 再来 hook 时，会再建一张新的（因为查询用的是非归档 todo——需要 verify 现有 `findTodoByNativeSessionId` 行为，spec 时确认） |
| 接管时本地 PTY 没退出 | 前端 confirm 强提示；后端不强制检测；若 spawn 失败会按现有 error 路径返回 |
| codex 30min 超时但用户其实还在用 | 接管按钮一旦点击会重置 status → 'running'；用户手动 reopen 卡片也可重置 |

## 安全 / 隐私

- **cwd 泄露到 IM**：默认 `redactCwd: 'basename'`，只把目录最后一段拼到推送文本里
- **首 prompt 截断 200 字**：description 里只存前 200 字（避免敏感长 prompt 整段进 db）
- **server 仍只绑 127.0.0.1**：不变。本地起的 hook 也是 POST 到 localhost，跨网络场景不在范围

## 测试计划

### 单元测试

- `test/openclaw-hook.local-capture.test.js`（新）
  - 无匹配 todo + autoCapture on + 任意触发事件 → 建出 1 张 todo，字段正确
  - 无匹配 + autoCapture off → 不建
  - 无匹配 + env skip → 不建
  - 有匹配 → 不建，走原流程
  - 并发 5 个 hook 同 nativeId → 只建 1 张（事务幂等）
- `test/openclaw-hook-installer.session-start.test.js`（新）
  - install 后 `~/.claude.json` 里有 SessionStart entry
  - 版本号正确递增
- `test/db.local-capture.test.js`（新）
  - `findTodoByNativeSessionId` 在 archived / deleted todo 下的语义

### 集成测试

- `test/routes/ai-terminal.adopt-local.test.js`（新）
  - source=local-capture 的卡 → POST adopt-local → spawn 被调一次，参数含 `resumeNativeId`
  - source=web 的卡 → POST → 400
  - 不存在 sessionId → 404

### 手测（验收）

按上面「验收标准」7 条逐条过。

## 验收标准

1. **claude 实时**：新 cwd 直起 `claude` → ≤2s web 端出现 `[本地 claude] xxx @ HH:mm` 卡片，status=running
2. **codex 首 prompt 后**：新 cwd 直起 `codex` → 用户输入第一句话回车后 ≤2s 出现卡片
3. **默认路由生效**：config 配了 defaultTelegramRoute → claude 首次 Stop hook → 飞书/Telegram 收到带 cwd basename 的推送
4. **幂等**：人工触发 5 次同 nativeSessionId 的 hook → DB 中只有 1 张 todo
5. **跳过开关**：`AGENTQUAD_SKIP_CAPTURE=1 claude` → 不建 todo，但既有 web 端创建的 session 通知仍正常
6. **接管**：web 卡上「接管」→ confirm → 后端 spawn `claude --resume`，xterm 看到流；source 变 adopted，按钮消失
7. **收尾**：
   - claude 在本地按 Ctrl+C / 退出 → SessionEnd hook → todo 状态变 completed
   - codex 在本地退出 → 30min 后状态变 completed
8. **不回归**：现有 web 端创建会话、现有 telegram/lark 推送行为 100% 不变；所有现有测试 pass

## 文件改动清单（实现指引）

```
src/openclaw-hook-installer.js     改：HOOK_EVENTS 加 SessionStart；version+1
src/openclaw-hook.js               改：handler 顶部加 ensureTodoForLocalSession 分支
src/db.js                          加：findTodoByNativeSessionId / createLocalCaptureTodo / 收尾 helper
src/config.js                      加：localSessions schema + 默认值
src/routes/ai-terminal.js          加：POST /adopt-local
src/server.js                      改：bootstrap 加 hook version 检查；GET /api/status 返回 hookOutdated
web/src/.../TodoCard.tsx           改：source=local-capture 时显示「接管」按钮 + 确认弹窗
web/src/.../Topbar.tsx             改：读 /api/status 显示 hook 升级 banner
docs/LOCAL-SESSIONS.md             新：用户向文档（配置项、工作流、FAQ）
docs/OPENCLAW.md                   改：补 SessionStart hook 说明
test/openclaw-hook.local-capture.test.js              新
test/openclaw-hook-installer.session-start.test.js    新
test/db.local-capture.test.js                          新
test/routes/ai-terminal.adopt-local.test.js            新
```

## 未决 / 后续

- **cursor 扩展**：cursor-hook-installer 当前没装"会话级"hook，未来若 cursor 提供等价机制，本架构里 `shouldCapture()` 加一行即可。
- **history 涌入**：若用户已经有大量历史 claude 进程，第一次开启本功能可能会被旧 hook 触发刷出一堆卡片。**当前设计不做特殊处理**——用户可以批量归档。如反馈强烈，再加一个「忽略 startedAt 早于 server 启动时间」的过滤。
- **codex 30min 超时**：先 hard-code，若未来需要再做成 config 项。
