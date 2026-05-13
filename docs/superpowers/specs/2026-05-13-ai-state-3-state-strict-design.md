# AI 会话三态严格化与标签统一

**Date**: 2026-05-13
**Status**: Draft — awaiting user review

## 目标

把"AI 会话状态"在前端的展示彻底收敛为三态：`running / 待确认 / idle`，并让所有相关 UI 用同一套标签和同一套推导逻辑。删除当前散落在多处的 `status === 'pending_confirm' || unread` 混合判断与 `pending_confirm` 特殊分支。

## 三态严格定义

| 态 | 含义 | 触发条件 |
|---|---|---|
| **running** | claude code 当前正在执行任务 | `liveSession.status === 'running'` |
| **待确认** | claude 回复了消息，用户还没看 | 不是 running，且 `unread === true`（`lastTurnDoneAt > lastSeenAt`） |
| **idle** | claude 当前没有在执行任务 | 上面两者都不成立 |

转换规则：
- 用户**看了**回复（任意 markSeen 触发：focus mount / dock 切回 / turn_done 时可见）→ `unread = false` → `pending → idle`。**包括 `status === 'pending_confirm'` 也照变。**
- 用户**回复了**（在该 session 终端输入并提交，后端把 `status` 推回 `running`）→ `idle/pending → running`。

### 关键设计选择

1. **`status === 'pending_confirm'` 不再是"待确认"态的充分条件**。它只是后端契约里的暂停态，前端不直接读它做状态推导。看了就是 idle；后端把它推到 running 才是 running。
2. **"已结束"子态（`done / failed / stopped`）全部折成 idle**。TranscriptView 的状态 chip 也按这个规则——不再单独显示"已完成 / 失败 / 已停止"。
3. **裸 `pending_confirm`（一上来就等 y/n、`lastTurnDoneAt = 0`）**：归为 idle。用户已确认可接受——这是严格语义的必然结果。

## 实施范围

### 新增

`web/src/design/aiPresentationState.ts`：

```ts
import type { AiStatus } from '../api'

export type AiPresentationState = 'running' | 'pending' | 'idle'

export function deriveAiState(
  status: AiStatus | undefined | null,
  unread: boolean,
): AiPresentationState {
  if (status === 'running') return 'running'
  if (unread) return 'pending'
  return 'idle'
}

export const AI_STATE_LABEL: Record<AiPresentationState, string> = {
  running: '● running',
  pending: '⚠ 待确认',
  idle:    '○ 空闲',
}

// 顶栏紧凑写法（数字旁的标签）
export const AI_STATE_PILL_LABEL: Record<AiPresentationState, string> = {
  running: 'running',
  pending: '待确认',
  idle:    'idle',
}
```

> 说明：标签字符串走两套是因为内联展示有图形字符（`●⚠○`），顶栏 pill 是纯文字。背后概念一致。

### 改动点位（6 处）

#### 1. `web/src/components/TodoCard/TodoCard.tsx:163-185`

- 删除当前块里 `isRunning / isPending / stateClass / label` 手写推导和 `status === 'pending_confirm' || unread` 表达式。
- 改用 `deriveAiState(liveSession?.status, unread)` 拿到 `state`，配合 `AI_STATE_LABEL[state]` 渲染。
- `stateClass` 直接使用 `state`，CSS 类名从 `todo-ai-state-pending_confirm` 改为 `todo-ai-state-pending`（同步更新 `TodoManage.css:949` 的选择器）。
- 顺手清理过期注释。

#### 2. `web/src/design/useDispatchStats.ts`

- `pendingCount` 改为只统计 `unread`（不再或上 `pending_confirm`）。
- 新增 `idleCount`。
- 移除 `tokenSum / tokenSumLabel`（顶栏的 `tok` 胶囊整颗撤下）。
- 接口 `DispatchStats` 简化为 `{ runningCount, pendingCount, idleCount }`。

#### 3. `web/src/components/TopbarDispatch/TopbarDispatch.tsx`

- 三颗 pill 从 `active / tok / pending` 改为 `running / idle / 待确认`。
- `running` 颗的 tooltip 列表保持原 active sessions 列表逻辑（status === 'running'）。
- `idle` 颗的 tooltip：列出当前所有 idle session（非 running 且非 unread），数量可能很多——只展示前 N 条 + "还有 X 条"。N 暂定 8。
- `待确认` 颗 Popover 行为不变（仍是点击展开列表 + jump），但列表内容跟 `replyHub` 一起变成"只剩 unread"。

#### 4. `web/src/replyHub.ts`

- 删除 `pendingConfirmSids` Set + "pending_confirm sessions are always included" 那段特殊分支。
- 删除 `UnreadReason` 类型与 `reason` 字段（消费方一并清理）。
- `buildUnreadSessionItems` 只输出 `unread`（`lastTurnDoneAt > lastSeenAt`）的 session。

#### 5. `web/src/TranscriptView.tsx:46-53`

- `sessionStatusMeta` 函数改为调用 `deriveAiState(status, unread)`，返回 `{ color, text }`，其中：
  - `running` → `processing` + `'running'`
  - `pending` → `error` + `'待确认'`
  - `idle` → `default` + `'空闲'`
- 不再区分 `done / failed / stopped` 子态。
- TranscriptView 的"thinking-label"等其他 `pending_confirm` 文案保留（这是会话内 inline 状态指示，跟外层 chip 不冲突）。

#### 6. `web/src/components/SessionFocus/FocusSubbar.tsx:21-26`

- 改用 `deriveAiState`，pill 文案统一到 `running / 待确认 / idle`。
- 此处当前不直接拿 `unread`，需要从 `useUnreadStore` 取 `lastSeenAt` 算一次。

### 标签统一

| 旧 | 新 |
|---|---|
| `运行中` / `active` | `running` |
| `待交互`（AiStatus 维度，TranscriptView 用） | `待确认` |
| `已完成 / 失败 / 已停止`（TranscriptView 状态 chip） | `空闲` |
| `idle` / `空闲` / `○ 空闲` | 视位置选 `idle`（顶栏 pill）或 `○ 空闲`（卡片内联） |

> **不动**：`TodoManage.tsx:128` 的 `'待交互'` 是 `todo.status === 'ai_pending'`（**todo 生命周期**），跟 AI session 状态是两个概念，保留。

### 不动的边界

- **后端 `AiStatus` 契约不变**（`'running' | 'done' | 'failed' | 'stopped' | 'pending_confirm'`）。
- **后端逻辑里的 `status === 'pending_confirm'` 仍然有效**（如 `src/routes/ai-terminal.js` 的暂停/恢复、`src/server.js` 的 active session 过滤）。这些是行为，不是展示。
- **`derivePetState` 不动**（宠物动画用，是另一套语义层）。
- **`AiTerminalMini.tsx:714` 的 `case 'pending_confirm'`** 是处理后端事件流，不动。
- **CSS variable `--ai-pending-confirm` 颜色变量保留**，作为"待确认"色用，只是不再绑 backend 状态名。

## 数据流图

```
后端 (AiStatus)               前端展示层 (3-state)
─────────────────             ──────────────────────
running          ────────→    running
pending_confirm  ────┐
                     ├──→  unread? ─yes→ pending
                     │              ─no──→ idle
done / failed /  ────┤
stopped              │
其它                  ─────→  (取决于 unread)
```

## 测试

### 新增单元测试

`web/src/design/aiPresentationState.test.ts`（新文件）：

- running 永远优先：`deriveAiState('running', true/false)` === `'running'`。
- pending_confirm + unread → `pending`。
- pending_confirm + 已读 → `idle`。
- done / failed / stopped + unread → `pending`；+ 已读 → `idle`。
- 任意 status + status==='running' 时 → `running`（即使 unread）。

### 现有测试调整

- `replyHub` 单测：删 pending_confirm 相关 case；新增 "live status === pending_confirm 且 lastTurnDoneAt 大于 lastSeen 时仍然进 unread 列表，但不再带 reason 字段" 的覆盖。
- `useDispatchStats` 单测：新增 `idleCount` 断言；删 `pending_confirm only` 的 case。
- TodoCard 相关组件测：CSS 类名从 `pending_confirm` 改 `pending`，断言对应更新。

### 端到端回归

- focus mode 打开 → markSeen 触发 → 卡片状态从 `待确认` 变 `idle`（即使 backend 仍 `pending_confirm`）。
- 用户在终端敲完回应 → backend 翻 `running` → 三处展示同步变 `running`。
- 顶栏 pill 数字 `running + pending + idle === 总 session 数`（除非有未在 sessions map 里的）。

## 验收标准

1. **行为**：
   - 三处展示（TodoCard / FocusSubbar / TranscriptView）+ 顶栏计数始终一致。
   - 已读后 `pending_confirm` session 立即变 idle，不需要 backend 状态翻转。
2. **代码清理**：
   - 仓库内（`web/src/` 范围）**不再出现** `status === 'pending_confirm' || unread` 这种混合表达式。
   - `replyHub.ts` 不再有 `pendingConfirmSids` / `UnreadReason` / `reason` 字段。
   - 顶栏不再有 `tok` 胶囊。
3. **测试**：新单测全绿；现有 web 端测试套件通过。
4. **手动回归**：以上 3 条端到端场景全部表现一致。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 裸 `pending_confirm`（lastTurnDoneAt=0）变 idle 后用户忘记响应 | 终端挂死 | 用户已知情且接受；后续需要时可在 idle pill tooltip 里标记此类 session |
| CSS 类名重命名漏改 | 卡片颜色错乱 | 改名前 grep 全仓库；本 PR 内统一替换 |
| `TranscriptView` 失去 failed/stopped chip 信息 | 历史会话定位变难 | 用户已知情；如确需，未来在 TranscriptView 顶部加 metadata 行（不在本次范围） |
| `replyHub.ts` 的 `UnreadReason` 字段被其他消费方依赖 | 编译/类型错误 | 跟改所有使用方（TopbarDispatch 已知用了 `item.reason`）|

## 不在本次范围

- 后端 `AiStatus` 契约变更。
- 宠物动画的 `derivePetState` 调整。
- TodoStatus（`ai_pending` 等）相关 UI。
- Token 上报数据源接通（`tok` 已撤）。
- 任何新增"挂死 pending_confirm 兜底提醒"机制（用户已确认无需）。
