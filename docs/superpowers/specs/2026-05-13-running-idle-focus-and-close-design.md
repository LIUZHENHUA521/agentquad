# Running / Idle 列表支持 Focus 与关闭 PTY — 设计

## 背景

顶部状态栏 `TopbarDispatch` 当前提供三个会话计数胶囊：

- **running** — 正在执行的 AI 会话；hover 出现 `tooltip` 仅展示列表。
- **idle** — 已就绪等待用户输入的会话；hover 出现 `tooltip` 仅展示列表。
- **待确认** — 有未读 IM/回复的会话；已经使用 antd `<Popover trigger="click">`，行可点击跳转到对应 session 的 focus 视图。

因为 running / idle 使用的是 `StatPill` 的 hover-only `tooltip`，所以：

1. 用户**无法**点击 dropdown 里的某一行来切到该 session 的 focus 视图（不像 "待确认"）。
2. 用户**无法**直接终止某个 running / idle session 对应的 PTY，需要先 focus 该 session 再点底部 Mini 终端的 Stop。

需求是把这两个胶囊升级成与 "待确认" 一致的可点击 Popover，并在每行追加一个关闭 PTY 的 `×` 按钮。

## 范围

**包含：**

- `TopbarDispatch` 中 running 与 idle 胶囊由 hover-tooltip 切换为 click-popover。
- Popover 中每行：行主体可点击进入 focus；行尾追加 `×` 按钮，点击调用 `stopAiExec(sessionId)` 终止 PTY。
- idle 列表保持现有 `IDLE_TOOLTIP_LIMIT = 8` 截断逻辑，"还有 X 条" 行只展示文字、无按钮。
- 空状态文案沿用 `No running sessions` / `No idle sessions`。

**不包含：**

- "待确认" 胶囊不变（不加 `×`），其语义与"关闭 PTY"不重合，本次仅按用户确认范围实施。
- 不引入二次确认（与 `AiTerminalMini.handleStop` 一致；停止 session 可逆——todo 自动回到 `'todo'` 状态、无数据损失）。
- 不修改后端：`POST /api/ai-terminal/stop` 与 `pty.stop` 既有行为足够。
- 不调整 focus 落地 tab；沿用 `useFocusStore.setFocus` 的默认行为（落到 `'conversation'`），与 "待确认" 点击行为一致。

## 现有可复用部件

| 部件 | 位置 | 用途 |
| --- | --- | --- |
| `useDispatchStore.openFocus(todoId, sessionId)` | `web/src/store/dispatchStore.ts:79` | 关闭抽屉/弹窗并把 focus 切到指定 session |
| `handleOpenTerminalInDock(todo, sessionId)` | `web/src/TodoManage.tsx:377` | 已封装 `openFocus`，是 "待确认" 行点击复用的入口 |
| `stopAiExec(sessionId)` | `web/src/api.ts:480` | `POST /api/ai-terminal/stop` 的客户端封装 |
| `LiveSession.todoId` | `web/src/api.ts:610` | session store 中已有，可直接进入行 entry |
| `deriveAiState` + `aiSessionStore` 状态变更 | `web/src/store/aiSessionStore.ts` | 收到后端 `done/stopped` 事件后会自动从 running/idle 列表移除该 session |

## UI / 交互设计

### Popover 结构

每个 running / idle 胶囊触发的 Popover 内容：

```
┌────────────────────────────────────────────────────────┐
│ Running sessions (N)                                    │  ← 标题（沿用现有 className）
├────────────────────────────────────────────────────────┤
│ ● <todoTitle ........................>  <tool>   [×]  │  ← 一行
│ ● <todoTitle ........................>  <tool>   [×]  │
│ ...                                                     │
└────────────────────────────────────────────────────────┘
```

- 行主体（dot + title + tool meta）是一个 `<button>`：点击 → 关闭 Popover → 调用上层注入的 `onFocus(todoId, sessionId)`。
- 行尾 `×` 是另一个 `<button>`：点击 → `e.stopPropagation()` → 调用上层注入的 `onStop(sessionId)`；按钮上有 `Tooltip` 提示 "停止该 session 的 PTY 终端"。
- 行 hover 时 `×` 透明度 / 颜色凸显（CSS 处理，不引入 JS 状态）。

### 状态与一致性

- 不做前端乐观删除。`stopAiExec` 返回 200 后，后端 PTY `done` 事件经 SSE/WebSocket 通过现有链路把 session 状态翻到 `stopped/done`，`deriveAiState` 自然把该行从 running/idle 列表过滤掉。这避免了"前端先删，但后端失败"的双向同步问题。
- 点击 `×` 期间该按钮 `disabled` + 显示极简 loading 态（行内 spinner 或 CSS opacity），防止重复点击。请求结束（成功或失败）后恢复。
- 错误：`stopAiExec` 抛出时用 antd `message.error('停止失败：...')`，不阻塞 Popover。

### Pending（待确认）保持不变

不在 pending 行上加 `×`。Pending 当前点击行只走 `onJump` → 进入 focus；本次不更改语义。

## 组件层面变更

### `web/src/components/TopbarDispatch/TopbarDispatch.tsx`

新增 props：

```ts
export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
  onFocusSession: (todoId: string, sessionId: string) => void  // ← 新增
  onStopSession: (sessionId: string) => Promise<void> | void   // ← 新增
}
```

要点：

- `runningList` / `idleList` entry 类型从 `{ id, title, tool }` 扩展为 `{ id, todoId, title, tool }`（`todoId` 来自 `session.todoId`）。
- 新增两个本地 `useState`：`runningOpen` / `idleOpen` 控制 Popover 开关；行点击 focus 时关闭。
- 把 running / idle 的 `StatPill` 包到 `<Popover trigger="click">` 里，content 用与 pending 同款的 row 列表组件。
- 抽出一个内部 `SessionRow` 渲染函数（仅在文件内），避免 running/idle 重复代码；保留现有 `topbar-tooltip-*` 类名以最小化 CSS 改动。
- 关闭按钮内部维护一个 `stoppingId: string | null` 防止重复点击；调用 `props.onStopSession`，无论成功失败都清状态。

### `web/src/components/TopbarDispatch/TopbarDispatch.css`

- 新增 `topbar-row-close-btn`：默认 `opacity: 0.45`，行 hover 时 `opacity: 1`；点击区域 ≥ 24px；disabled 状态降低对比。
- 调整 row 的 grid/flex，让 `×` 始终右贴。

### `web/src/TodoManage.tsx`

- 给 `<TopbarDispatch>` 传入：
  - `onFocusSession`：新增轻量包装 `handleFocusSessionById = useCallback((todoId, sessionId) => { const todo = todos.find(t => t.id === todoId); if (todo) handleOpenTerminalInDock(todo, sessionId) }, [todos, handleOpenTerminalInDock])`。保留 `handleOpenTerminalInDock` 既有签名以免影响其它调用方。
  - `onStopSession={handleStopSession}`：`useCallback(async (sessionId) => { try { await stopAiExec(sessionId) } catch (e) { message.error(...) } }, [])`。
- `stopAiExec` 已在 `web/src/api.ts` 导出，导入即可。

### `web/src/components/TopbarDispatch/index.ts`

- 如果新增了导出的辅助类型（例如 `SessionRowEntry`），在 index 里 re-export。否则不动。

## 数据流

```
┌──────────────────────┐   click row   ┌────────────────────────────────────┐
│ TopbarDispatch       │ ───────────▶ │ onFocusSession(todoId, sessionId)  │
│  - runningList[]     │               │  → TodoManage.handleFocusSessionById│
│  - idleList[]        │               │  → dispatchStore.openFocus(...)    │
│                      │               └────────────────────────────────────┘
│                      │   click ×     ┌────────────────────────────────────┐
│                      │ ───────────▶ │ onStopSession(sessionId)           │
│                      │               │  → stopAiExec(sessionId)           │
│                      │               │  → POST /api/ai-terminal/stop      │
│                      │               │  → pty.stop(sessionId)             │
│                      │               │  → 'done' 事件 → aiSessionStore    │
│                      │               │     updateSessionStatus            │
│                      │               │  → deriveAiState 过滤 → 行消失      │
└──────────────────────┘               └────────────────────────────────────┘
```

## 错误处理

- `stopAiExec` 404（session 在请求前已结束）：吞掉错误，因为最终一致性会通过 'done' 事件让该行消失；不打扰用户。
- 其他错误：`message.error('停止失败: ' + err.message)`；行保持可见，可重试。
- 行已经从 store 中消失但 Popover 还开着：React 重新渲染会自动去掉该行；无需特殊处理。

## 测试策略

**组件测试（Vitest + RTL）：**

- 渲染 `TopbarDispatch`，store 注入 2 个 running、1 个 idle session：
  - 点击 running 胶囊，Popover 展开，断言显示 2 行。
  - 点击第一行主体，断言 `onFocusSession(todoId, sessionId)` 被调用且 Popover 关闭。
  - 点击行尾 `×`，断言 `onStopSession(sessionId)` 被调用，且 Popover **不关闭**（其它行还能继续操作）。
  - 重复点击同一个 `×`：第二次 `onStopSession` 不应再被调用（按钮 disabled）。
- 空状态：runningList 为空，断言 "No running sessions" 仍然显示。
- idle 截断：注入 10 个 idle session，断言显示 8 行 + "还有 2 条" 文案；"还有 X 条" 行无 close 按钮。

**E2E（可选，如 ai-coding-e2e-harness fixture 可用）：**

- mock 一个 running session → 点击 running 胶囊 → 点击行主体 → 断言 focus 视图打开。
- mock 一个 running session → 点击 `×` → 断言后端收到 `/api/ai-terminal/stop` 请求 → mock 'done' 事件 → 断言行从 dropdown 消失。

## 复杂度评估

- 改动文件 ≤ 4 个，CSS ~30 行，TSX ~80 行净增。
- 后端零改动。
- 无数据库 / schema 变更。
- 无新依赖。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 用户误点 `×` 把 running session 杀掉 | 已确认不加二次确认；行尾按钮 + 默认半透明 + hover 才高亮，已经比"显眼按钮"更克制。停掉的 session 可通过 history recovery 恢复。 |
| 重复请求 stop | `stoppingId` 状态 + `disabled` 按钮 |
| Popover 与 pending Popover 抢焦点 | 每个 Popover 各自独立 `open` 状态，互不影响 |
| running / idle 列表在 stop 过程中重新计算导致 hook 抖动 | 使用 sessionId 作为 React `key`；列表变化通过 store 驱动，不引入新副作用 |

## 实施顺序（供 writing-plans 参考）

1. 给 `TopbarDispatch` 新增 props 与 row entry 携带 `todoId`，先把 `StatPill` 包到 Popover 里（focus 行为先打通）。
2. 加 `×` 按钮 + `stoppingId` 状态 + CSS。
3. 在 `TodoManage` 接入 `handleStopSession` 与 focus 包装。
4. 写组件测试。
5. 本地浏览器手测 running + idle 两条路径。
