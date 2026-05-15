# AI Terminal 失败路径自动恢复（方案 C + 退避重试）

- 日期：2026-05-15
- 作者：刘振华 / Claude
- 关联模块：`web/src/AiTerminalMini.tsx`、`src/pty.js`、`web/src/i18n/locales/{zh-CN,en-US}.ts`
- 关联现有文档：`2026-05-13-claude-stop-hook-false-positive-design.md`、`2026-04-22-ai-terminal-width-fix-design.md`

---

## 1. 背景与问题

当 AI（claude / codex）PTY 子进程**非 0 退出**时（截图中"任务失败"场景），现状是：

1. `src/pty.js:848` `proc.onExit({exitCode})` 触发 → `src/server.js:1324` 推 WS `done` 事件
2. `web/src/AiTerminalMini.tsx:696-700` 写出 `=== 任务失败 ===` 横幅，把 sessionStatus 切到 `'todo'`，**之后什么都不做**
3. xterm 的 screen buffer 保留 claude TUI 最后一帧（`9% context` / `bypass permissions on (shift+tab to cycle)` / 输入框），视觉上像还在运行
4. 工具栏的「恢复会话」按钮**只在 `sessionExpired === true`（WS 4004 路径）下露出**，failure 路径下不显示
5. 用户敲键无响应（PTY 已死），同时看不到任何能点的恢复入口 → **体感卡死**

## 2. 目标

非 0 退出时：
1. 自动尝试 resume，最多 3 次，带退避（1s → 3s → 8s）
2. 重试期间隐藏"任务失败"红色横幅，改写黄色"正在自动恢复 (n/3)..."
3. 中途任一次成功 → 静默继续，用户无感
4. 全部失败 → 落到与现有 `sessionExpired` 路径**完全一致的工具栏 UI**（红色 Tag + 「恢复会话」+「关闭」按钮）

非目标：
- 不改 `done` WS 协议字段（不引入 `signal` / `tailLog`，留给后续单独的诊断方案）
- 不做诊断信息回传 / 不做"为什么失败"的根因分析
- 不改正常完成（exitCode === 0）路径的任何行为

## 3. 设计概览

### 3.1 状态模型

新增一个 ref `failureRecoveryRef`（不是 React state，避免在重试循环里触发渲染）：

```ts
type FailureRecoveryState =
  | { phase: 'idle' }
  | { phase: 'recovering', attempt: number, exitCode: number }
  | { phase: 'exhausted', exitCode: number }
```

UI 层暴露一个 `sessionFailed: boolean` state，仅在 `phase === 'exhausted'` 时为 true。

### 3.2 触发与短路

WS `case 'done'` 收到时（`src/routes/ai-terminal.js:475` 已经把 `aiStatus` 推为 `'done'` / `'failed'` / `'stopped'`）：

| `msg.status` | 行为 |
|--------------|------|
| `'done'` | 正常完成，走原绿色 `=== AI 任务已结束 ===` 分支 |
| `'stopped'` | 用户主动 stop（route 已写过 `type:'stopped'` 黄色 `=== 已中止 ===` 横幅，这里只更状态，不再追加红字、不触发自动恢复） |
| `'failed'` | **新逻辑**：触发自动恢复循环 |

短路条件（任一满足时不触发自动恢复，直接走 exhausted UI / 不变行为）：

1. `recoveringRef.current === true`（已有 4004 路径在 recover）—— 让那一路跑完
2. `resumeTargetRef.current?.nativeSessionId` 不存在 —— 没有可 resume 的目标，直接 exhausted UI（工具栏「关闭」按钮，不显示恢复按钮）
3. `disposedRef.current === true` —— 组件已 unmount

### 3.3 重试循环

```
attempt 1: 等 1s → tryAutoRecover()
  ├─ 成功 → phase='idle'，正常继续（与 4004 recover 完全一致）
  └─ 失败 → 写 "自动恢复失败 (1/3)：{{reason}}" → attempt 2
attempt 2: 等 3s → tryAutoRecover() → 同上
attempt 3: 等 8s → tryAutoRecover()
  ├─ 成功 → 同上
  └─ 失败 → phase='exhausted'，写最终 "任务失败" 横幅 + 露出工具栏按钮
```

退避表 `BACKOFF_MS = [1000, 3000, 8000]`，常量定义在文件顶部，方便 e2e 时被 mock 成短数。

### 3.4 改造现有 `tryAutoRecover`

当前 `tryAutoRecover` (line 224) 用 `recoveryAttemptedRef.current` 做"整个组件生命周期只允许 recover 一次"的硬限制，会和我们的 3 次重试冲突。

最小改动：
- 把 `recoveryAttemptedRef` 的语义从"是否尝试过"改为"是否成功 recover 过"——只有成功路径才置 true
- 失败路径不置 `recoveryAttemptedRef`，但保留 `recoveringRef` 做并发互斥
- 已有的 4004 / visibility / focus 三处调用方语义不变（它们本就只调用一次）

### 3.5 失败路径 UI 复用

工具栏渲染条件从：
```tsx
{sessionExpired && <Tag>会话已失效</Tag>}
{sessionExpired && resumeTargetRef.current?.nativeSessionId && <Button>恢复会话</Button>}
{sessionExpired && <Button>关闭</Button>}
```

扩成：
```tsx
{(sessionExpired || sessionFailed) && <Tag>会话已失效</Tag>}
{(sessionExpired || sessionFailed) && resumeTargetRef.current?.nativeSessionId && <Button>恢复会话</Button>}
{(sessionExpired || sessionFailed) && <Button>关闭</Button>}
```

文案 `sessionExpired` 标签复用，**不另外引入 `sessionFailed` 文案**——用户视角下两者表达的都是"会话已结束，请决定下一步"。

「恢复会话」按钮的 `handleManualRecover` 调用方式不变，只是要在调用前 reset `recoveryAttemptedRef = false`，让按钮始终能再试。

### 3.6 i18n 文案

`web/src/i18n/locales/zh-CN.ts` 在 `session.terminal.writeln.*` 下新增：

```ts
autoRecoverAttempt: '检测到会话异常退出 (exit {{code}})，正在自动恢复 ({{attempt}}/{{max}})...',
autoRecoverGiveUp: '自动恢复 {{max}} 次均失败，请手动操作',
```

en-US 对应：

```ts
autoRecoverAttempt: 'AI session exited unexpectedly (exit {{code}}). Auto-recovering ({{attempt}}/{{max}})...',
autoRecoverGiveUp: 'Auto-recover failed after {{max}} attempts. Please recover manually.',
```

最终的 `=== 任务失败 ===` 横幅文案不变（`aiTaskFailed`），保持视觉锚点一致。

### 3.7 取消

如果重试期间发生以下任一事件，立刻终止剩余重试：
- 组件 `disposed`（unmount）
- 用户点击 `onClose`（关闭终端）
- 收到了 `session_restarted` / 4004 等其他恢复路径的成功事件

实现：把 setTimeout 的 timer 句柄存到 `failureRecoveryTimerRef`，cleanup 时 clearTimeout。

## 4. 详细变更清单

### 4.1 后端

`src/pty.js` `done` 事件已带 `stopped`（line 884），`src/routes/ai-terminal.js:418-475` 已把它映射为 `aiStatus: 'failed' | 'stopped' | 'done'` 并推到 WS。**后端不需要任何改动。**

### 4.2 `web/src/AiTerminalMini.tsx`

- 新增 `BACKOFF_MS`、`MAX_FAILURE_RETRIES` 常量
- 新增 `failureRecoveryRef`、`failureRecoveryTimerRef`、`sessionFailed` state
- 改造 `tryAutoRecover`：`recoveryAttemptedRef` 只在成功路径 set
- 新增 `runFailureAutoRecover(exitCode)` 函数：管理重试循环
- 改 `case 'done'`：当 `msg.status === 'failed'` → 不写 "任务失败" 横幅，转而调 `runFailureAutoRecover(msg.exitCode)`；`msg.status === 'stopped'` 沿用现有"已中止"路径，**不**追加红字
- 改工具栏渲染条件：`sessionExpired || sessionFailed`
- 改 `handleManualRecover`：调用前 reset `recoveryAttemptedRef`
- 在组件 cleanup 里清 `failureRecoveryTimerRef`

### 4.3 `web/src/i18n/locales/zh-CN.ts` & `en-US.ts`

新增两条文案 `autoRecoverAttempt` / `autoRecoverGiveUp`。

## 5. 边界与风险

| 场景 | 行为 |
|------|------|
| 用户主动 stop → exit 非 0（SIGTERM） | server 端把 status 标成 `'stopped'`（不是 `'failed'`），前端不触发自动恢复，沿用现有"已中止"显示 |
| 重试中途用户 close 终端 | `disposed` → clearTimeout，本轮重试丢弃 |
| 重试中途 4004 自动 recover 成功 | `recoveringRef` 互斥，failureRecoveryRef 看到 phase 已被外部改 → 中止 |
| 没有 nativeSessionId（首次启动就崩） | 跳过重试，直接 exhausted UI，让用户手动重启 todo |
| claude 启动二进制缺失（424 tool_missing） | 第 1 次就会拿到 `setToolMissing`，按现有逻辑直接走修复卡片，不再继续 8s 退避 → 需要在重试循环里检测 `toolMissing` 提前 break |
| 多 tab 同 sessionId | 重试是前端 client-side 行为，每个 tab 独立。后端 recover 端点本身已是幂等（同一 nativeSessionId resume 会复用），不会出现重复 PTY |
| 退避 8s 期间用户不耐烦点了某个按钮 | 只露出「恢复会话」「关闭」，前者本来就要触发 manual recover；按下时 cancel 自动重试，立刻进 manual 路径 |

## 6. 验收标准

1. **非 0 退出非主动停止时**：终端立刻显示黄色 `检测到会话异常退出 (exit {{code}})，正在自动恢复 (1/3)...`；不再出现 `=== 任务失败 ===` 红字（除非 3 次都失败）
2. **3 次中任一次成功**：UI 静默切到新 sessionId，恢复正常 ai_running，没有红字干扰
3. **3 次全部失败**：终端写出 `自动恢复 3 次均失败` + `=== 任务失败 ===` 红字，工具栏出现红色 `会话已失效` Tag + 「恢复会话」 + 「关闭」按钮（与现有 `sessionExpired` 路径**像素级一致**）
4. **用户主动停止（stop 按钮）**：行为完全不变，不触发自动恢复
5. **正常完成（exitCode === 0）**：行为完全不变，写绿色 `=== AI 任务已结束 ===`
6. **手动「恢复会话」按钮**：在 exhausted 状态下仍可点，点击后进入和现有 4004 manual recover 一样的流程
7. 单测：
   - `web/src/AiTerminalMini.tsx` 增加 case：模拟 WS 收到 `{type:'done', exitCode:1, status:'failed'}` → 断言 `tryAutoRecover` 被调用、3 次都 mock 失败后 toolbar 显示 sessionExpired 风格的 Tag + Button
   - 模拟 `{type:'done', status:'stopped'}` → 断言**不触发** `tryAutoRecover`，沿用现有"已中止"路径
   - mock `BACKOFF_MS = [10, 10, 10]` 加速测试

## 7. 不在范围

- `done` WS 协议增加 `signal` / `tailLog` 字段（B 方案，留待后续）
- 自动恢复后是否要"提示用户上一轮可能未完成"（现在静默切，先观察体感）
- 多次 exit 的判失败次数与窗口（先用每次 mount 独立计数；如果将来发现高频崩溃要做熔断再扩展）

## 8. Open Questions

无（已与用户对齐：方案 C + 退避 b + 重试期文案 a + 兜底 UI 复用 a + UI 统一）。
