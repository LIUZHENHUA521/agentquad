---
title: AttentionRail 只展示「待确认」AI 会话
date: 2026-05-11
status: approved
---

# 背景

左侧竖向条 `AttentionRail`（`web/src/dock/AttentionRail.tsx`）当前显示三类 attention 项：

| kind | 颜色 | 含义 |
| --- | --- | --- |
| `interaction` | 红 (`#ff4d4f`) | AI 跑完等用户确认（`pending_confirm`） |
| `awaiting_reply` | 橙 (`#faad14`) | AI 在等用户输入 |
| `review` | 蓝 (`#1677ff`) | AI 已完成、等用户验收 |

顶部红色圆形计数显示的是「未读会话数」（按 `lastTurnDoneAt > lastSeenAt` 计算），与下方徽章语义不完全对齐。

# 目标

让 `AttentionRail` 在视觉与计数上彻底聚焦「待我确认（`pending_confirm`）的 AI 会话」，不再混入「待回复 / 待验收」。Dashboard 抽屉保持现状（仍展示三类）。

# 改动范围

只涉及视图层与一处调用方，不动数据源。

## `web/src/dock/AttentionRail.tsx`

- Props 调整：保留 `items` / `counts` / `onActivate` / `onOpenDashboard`；删除 `unreadCount`、`hasNew`
- 渲染前过滤：`const interactionItems = items.filter(i => i.kind === 'interaction')`
- 顶部红色按钮：显示 `counts.interaction`（>99 显示 `99+`），`title` 改为 `待确认：${counts.interaction}`
- 收起判定：`if (counts.interaction === 0) return <div className="attention-rail attention-rail--empty" />`
- 闪烁脉冲（`is-alerting` class）：`counts.interaction > 0` 时触发
- `items.slice(0, 12)` 改为 `interactionItems.slice(0, 12)`；「+N 更多」按钮按 `interactionItems.length` 计算

## `web/src/TodoManage.tsx`

- 调用 `<AttentionRail .../>` 时移除 `unreadCount` / `hasNew` 两个 prop
- 用 grep 确认 `unreadCount` / `hasNewAttention` / `acknowledgedAttentionIds` 这几个变量除了 rail 外是否还有其它消费者；如果只剩 rail 用，顺手清理；否则保留

# 数据流

```
buildAttentionItems(todos, liveSessions, seen)
        │
        ▼ 全量 items (3 kinds)
  ┌──────────────┬──────────────────┐
  ▼              ▼                  ▼
DashboardDrawer  AttentionRail   (counts.interaction 用于显示/收起)
(三类全展示)    (过滤为 interaction)
```

`buildAttentionItems` 内部逻辑、`countAttentionItems` 输出结构均不变。

# 边界 & 异常

- `counts.interaction === 0` 且无其它 kind → rail 收起为 8px 细线（与现状一致）
- `counts.interaction === 0` 但仍有 awaiting_reply / review → **新行为：rail 也收起为细线**。用户如需查看，从其它入口打开 Dashboard 抽屉

# 验收清单

- [ ] 左 rail 只出现红色圆字徽章；橙/蓝徽章彻底不出现
- [ ] 顶部红圈数字 = `counts.interaction`，tooltip 文案 = `待确认：N`
- [ ] `counts.interaction === 0` 时 rail 收起为 8px 细线（即使存在待回复/待验收会话）
- [ ] 打开 Dashboard 抽屉仍能看到「待交互 / 待回复 / 待验收」三种 chip
- [ ] 点击 rail 上的徽章仍能正常打开对应 AI 会话
- [ ] 当 `counts.interaction > 0` 时，顶部按钮触发脉冲动画（`is-alerting`）

# 不做的事

- 不改 `buildAttentionItems` 内部逻辑（dashboard 仍需要三类数据）
- 不改 `AttentionHub` / `DashboardDrawer`
- 不删除 CSS 中 `kind-awaiting_reply` / `kind-review` 样式（保留以备复用）
- 不动 `useUnreadStore` / `lastSeenAt` 体系，仅在 rail 层不再消费
