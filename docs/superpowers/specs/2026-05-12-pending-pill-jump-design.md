# Pending Pill 点击跳转 + 删除 AttentionRail

- 日期: 2026-05-12
- 状态: Approved (waiting for plan)
- 范围: `web/src` 前端 UI

## 背景与动机

桌面端目前有两处入口指向同一类"需要用户处理"的 AI 会话：

1. **左侧 AttentionRail**（`web/src/dock/AttentionRail.tsx`）：渲染首字符圆形头像，点击 → 打开 SessionFocus + 滚动并高亮对应 Todo 卡片。
2. **顶栏 `pending` StatPill**（`web/src/components/TopbarDispatch/TopbarDispatch.tsx`）：仅作数量徽标和 hover Tooltip，**不可点击跳转**。

用户希望删除左侧 Rail，将"列表 + 跳转"能力下沉到 `pending` Pill，减少冗余 UI、让所有"待处理"入口集中在顶栏。

## 用户故事

- 作为开发者，当顶栏显示 `2 pending` 时，我能**点击**这个 Pill 直接看到这两个会话，并点其中一个跳转到对应卡片。
- 桌面端不再看到左侧那条圆形头像导航栏。
- 移动端行为不变（AttentionRail 原本就 `return null`）。

## 现状（不改）

- `useDispatchStats()` 返回 `activeCount / pendingCount / tokenSumLabel`，`pendingCount` 计算自 `useAiSessionStore` 的 live sessions，规则：`status === 'pending_confirm' || unread`。
- `buildUnreadSessionItems(...)` 接收 `todos + liveSessions + lastSeenMap`，输出 `UnreadSessionItem[]`，规则**只**按 `lastTurnDoneAt > lastSeen` 判断 unread，**未**显式包含 `pending_confirm` 状态。
- `handleOpenAttentionItem(item: UnreadSessionItem)`（`TodoManage.tsx`）：清空筛选 → openFocus → setHighlightTodoId → setPendingJumpTodoId → 3 秒高亮定时器。已稳定可复用。

## 设计

### 概览

```
Topbar:  [logo] [active] [tok] [pending ▼]    ⌘K   🔍 📊 📖 ⚙ 🎨
                              └── click ─→ Popover
                                           ├ Title "待处理 (N)"
                                           ├ Row · Row · Row  ← 点击 → openFocus + 滚动 + 高亮
                                           └ Empty hint when N===0
```

桌面端左侧 AttentionRail 整体移除。

### 数据源统一

**目标**：`pending` Pill 数字、Popover 行数、原 AttentionRail 三者口径完全一致；点击行可直接拿到 `todoId + sessionId`。

**改动**：扩展 `buildUnreadSessionItems` 的判定，使其同时包含两类 session：

- 任意 `session.status === 'pending_confirm'` 的 live session（不管 lastTurnDoneAt / lastSeen）
- 原有的"unread reply"判定（`lastTurnDoneAt > lastSeen`）

合并后按 `timestamp` 倒序去重。返回值结构 `UnreadSessionItem` 不变（已含 `todoId / sessionId / todoTitle / tool / timestamp`），新增可选字段 `reason: 'pending_confirm' | 'unread'` 供 UI 区分展示。

> 备注：这次扩展不影响其它消费方（grep 结果显示该函数仅在 `TodoManage.tsx` 使用一处）。`useDispatchStats` 仅继续暴露 `pendingCount`，但**实现改为基于扩展后的 `buildUnreadSessionItems`，或直接由消费侧用 `items.length`**（详见"组件改动"）。

### 组件改动

#### `web/src/components/TopbarDispatch/TopbarDispatch.tsx`
- 移除原内联 `pendingList` 拼装逻辑。
- 从 props 或 selector 接入 `unreadItems: UnreadSessionItem[]`（由 `TodoManage` 计算后透传，或在组件内自行用 `buildUnreadSessionItems` + 既有 store hooks 计算 —— 二选一详见下方决策）。
- `pending` Pill：
  - 数量 = `unreadItems.length`
  - 去掉 `tooltip` prop（不再 hover 弹）
  - 包一层 AntD `Popover`（`trigger="click"`，`placement="bottomRight"`），点 Pill 触发
  - 当 `unreadItems.length === 0`：Pill 仍可点击，Popover 内显示空态文案 "No pending"（保留与现有行为一致的反馈，无需做 disabled 处理）
- Popover 内容：
  - 标题：`待处理 (N)`
  - 列表项（按钮）：左侧圆点（颜色按 reason：pending_confirm 用 `--ai-pending-confirm`，unread 用 `--ai-error`）+ 标题 + 右侧 `tool · 待批准/未读`
  - 点击：调用从父级传入的 `onJump(item: UnreadSessionItem)`；选中后关闭 Popover

#### `web/src/TodoManage.tsx`
- 把现有的 `unreadItems` + `handleOpenAttentionItem` 透传给 `TopbarDispatch`（新增 props）。
- 删除 `<AttentionRail .../>` 渲染与 `import AttentionRail from './dock/AttentionRail'`。

#### `web/src/dock/AttentionRail.tsx`
- 删除文件。

#### `web/src/TodoManage.css`
- 删除 `.attention-rail`、`.attention-rail--empty`、`.attention-rail__items`、`.attention-rail__item*`、`.attention-rail__more` 选择器块。
- 因为外层 `.todo-manage-shell` 使用 flex 布局，AttentionRail 被删后右侧主区会自然撑满。确认无残留间距/边框（QA 阶段视觉核对）。

#### `web/src/replyHub.ts`
- `UnreadSessionItem`：新增可选字段 `reason?: 'pending_confirm' | 'unread'`。
- `buildUnreadSessionItems`：补 `pending_confirm` live session 的合并逻辑（无 lastTurnDoneAt 时 timestamp 取 `Date.now()` 或保持 0 + 排在 unread 之后 —— 见下方决策）。

#### `web/src/design/useDispatchStats.ts`
- 保留对外接口（`pendingCount` 字段）；如要保持单测稳定，内部计数逻辑可以不动，**让 Pill 改用 `unreadItems.length` 作为唯一展示口径**。两者并行的过渡期由测试保证一致性。
- 后续可在另一个清理 PR 中下线 `pendingCount`，本次不动以缩小 blast radius。

### 数据流

```
TodoManage
  ├ useAiSessionStore → liveSessionsMap
  ├ useUnreadStore   → lastSeenMap
  ├ todos (state)
  └ unreadItems = useMemo(buildUnreadSessionItems({...}))
        │
        └─ props ─→ TopbarDispatch
                      ├ pending Pill (count = unreadItems.length)
                      └ Popover rows → onJump(item) → handleOpenAttentionItem(item)
                                                        └ openFocus + 滚动 + 高亮
```

### Pill / Popover 视觉

- Pill `variant`：保持 `unreadItems.length > 0 ? 'alert' : 'default'`。
- Popover 宽度：max-width ≈ 320px；行 hover 高亮（沿用 `--surface-2`）。
- 圆点颜色：`pending_confirm` → `--ai-pending-confirm`；`unread` → `--ai-error`（与原 Rail 的 kind-unread / kind-awaiting_reply 配色一致）。
- 文案：标题 `待处理 (N)`；空态 `No pending`；行右侧 meta `tool · 待批准|未读`。

## 关键决策（已确认）

1. **完全删除 AttentionRail**（组件文件 + CSS + import + 渲染处）。
2. **数据源统一**：Pill 数字、Popover 列表共用 `buildUnreadSessionItems`（扩展后含 `pending_confirm`）。
3. **去 Tooltip，只保留点击 Popover**：Pill 不再 hover 弹层。
4. **`pendingCount === 0` 时**：Pill 仍可点击，Popover 显示 "No pending" 空态。
5. **本次不加快捷键**。

## 仍待执行时确认（小尺度）

- **传参方式**：`TopbarDispatch` 接受 `unreadItems + onJump` props，还是内部自己调 `buildUnreadSessionItems`？倾向**前者**（父级已计算，避免重复 useMemo；E2E 注入更可控）。
- **`pending_confirm` 无 `lastTurnDoneAt` 时的 timestamp**：取 `Date.now()`（语义上"刚发生，需要立即处理"，置顶）还是保留为 0（沉底）？倾向 **`Date.now()`**，让"刚需要确认"的项排在最上。

## 不在范围内

- 移除/重构 `useDispatchStats.pendingCount`（保留至下一个清理 PR）。
- 修改 Pending 的告警声/Toast/Telegram 通知策略。
- 移动端样式调整（AttentionRail 在移动端原本就 hidden）。
- StatPill 组件的样式系统翻新。

## 测试

### 单元（Vitest）
- `buildUnreadSessionItems`：
  - 单纯 `pending_confirm` live session，无 lastTurnDoneAt → 返回项 `reason='pending_confirm'`，timestamp 排在最前
  - 单纯 unread reply（lastTurnDoneAt > lastSeen） → `reason='unread'`
  - 同一 sessionId 既 pending_confirm 又 unread → 去重为 1 项，reason 优先 `pending_confirm`
  - 已 seen 且非 pending_confirm → 不返回

### 组件 / RTL（可选）
- `TopbarDispatch` 渲染时：`pendingCount=0` Pill 可点；点开 Popover 显示空态文案
- `pendingCount=2` Pill 点开后渲染 2 行；点击某行调用 `onJump(item)` 一次，参数为对应 item
- 不再渲染 `data-testid="stat-pending"` 的 hover tooltip 内容（保留 testid）

### E2E（Playwright，沿用 `ai-coding-e2e-harness`）
- 构造 1 个 `pending_confirm` 会话 → 顶栏看到 `1 pending`，点 Pill 弹出 1 行 → 点击 → SessionFocus 打开 + 对应卡片滚动入视
- 桌面端断言 `.attention-rail` 选择器不存在
- 移动视口断言 `.attention-rail` 同样不存在（保持原行为）

### 手测清单
- 桌面 1280×800：删除 Rail 后，主区右移 ≈ 56px（含原 Rail + 边框），无残留分隔线
- Pending 计数 0 → 1 → 0 切换时 Pill 视觉变化（alert/default）正确
- Popover 点击外部关闭、列表项点击后自动关闭

## 验收标准

- ✅ 桌面端 DOM 无 `.attention-rail*` 元素
- ✅ `pending` Pill 可点击，count > 0 时展开列表，行可点击跳转（openFocus + 卡片滚动 + 3 秒高亮）
- ✅ Pill 数字 = Popover 行数 = 扩展后 `buildUnreadSessionItems` 长度
- ✅ Pill 不再有 hover tooltip
- ✅ `pendingCount === 0` 时 Popover 显示 "No pending" 空态
- ✅ 移动端无回归
- ✅ 现有 `data-testid="stat-pending"` 保留；Popover 内行加 `data-testid="topbar-pending-row"` 便于 E2E

## 风险与回滚

- **数据源切换**带来 Pill 数字短期波动（新增了原本被 lastSeen 过滤掉的 `pending_confirm` 项）。回滚：保留旧 `pendingCount` 即可瞬时退回。
- **Popover 与 `⌘K` 命令面板**热键冲突？目前 `togglePalette` 只响应 ⌘K，无影响。
- **删除 AttentionRail** 不可逆，但 git 历史可还原；该组件无被其它非 TodoManage 处引用（已 grep 确认）。
