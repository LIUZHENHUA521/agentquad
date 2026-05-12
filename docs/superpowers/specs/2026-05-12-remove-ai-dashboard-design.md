---
title: 删除 AI 工作面板（DashboardDrawer）
date: 2026-05-12
status: proposed
---

# 背景

`AI 工作面板`（`web/src/dashboard/DashboardDrawer.tsx`）是一个右侧抽屉，由顶部工具栏的「AI 面板」按钮 + `AttentionRail` 中央数字球两个入口触发。它包含 4 个 section：

1. `KpiStrip` — 4 个 KPI 块（运行中 / 待确认 / 今日完成 / 平均耗时） + sparkline
2. `AttentionHub` — 待处理 AI 会话，分「待交互 / 待回复 / 待验收」三档
3. 「实时会话」(`LiveList`) — 排除 `pending_confirm` + `awaitingReply` 后的运行中 session 卡片
4. 折叠区：`HistoryStatsTab`（历史统计）+ `ResourceTab`（资源占用）

主工作台（`TodoManage.tsx`）此时已经常驻 `AttentionRail`（左侧未读气泡）和 `TerminalDock`（底部 dock），覆盖了「未读 session 点开 → 跳 terminal」以及「运行中 session 卡片」两条路径。面板里的内容与主工作台高度冗余，且 KPI/历史统计/资源占用 非 actionable。

用户判断："工作台已经有了，感觉信息冗余。"

# 目标

彻底删除 AI 工作面板：抽屉本体 + 4 个 section + 2 个入口（顶栏按钮 + 数字球）+ 主页相关 state/handler/memo。`AttentionRail` 的头像列表（基于未读）保留。后端 stats/resource endpoint 暂不动。

# 不做的事

- 不删后端 endpoint（`/api/sessions/stats`、`/api/resource/*` 等），仅删前端调用。后端死代码清理留作后续专项。
- 不在每个 todo 卡上新增「待交互 / 待验收」徽章。如果删除后真的不可缺，单独立项。
- 不重构 `replyHub.ts` 内部逻辑，只移除不再被消费的 export。
- 不动 `TerminalDock` / `useTerminalDockStore`。
- 不动 mobile 端的 `Modal` 形态以外的整体布局。

# 改动范围

## 删除：`web/src/dashboard/` 整个目录

文件清单：
- `DashboardDrawer.tsx`
- `KpiStrip.tsx`
- `AttentionHub.tsx`
- `LiveSessionCard.tsx`
- `LiveGlanceTab.tsx`
- `HistoryStatsTab.tsx`
- `ResourceTab.tsx`
- `dashboard.css`

## `web/src/TodoManage.tsx`

删除：
- `import DashboardDrawer from './dashboard/DashboardDrawer'`
- `import { AttentionItem, buildAttentionItems, ... } from './replyHub'` 里**仅由面板消费**的符号（保留 `UnreadSessionItem` / `buildUnreadSessionItems`，rail 还在用）
- `const [dashboardOpen, setDashboardOpen] = useState(false)`
- `useDrawerStack('dashboard', dashboardOpen, () => setDashboardOpen(false))`
- `attentionItems` useMemo
- `handleDashboardOpenTerminal` / `handleDashboardStop` callback
- `handleMarkAttentionSeen` / `handleClearReviewAttention` callback（仅由面板消费的话；用 grep 二次确认）
- 顶部工具栏的「AI 面板」按钮（`<Button icon={<DashboardOutlined />} ...>`）
- mobile 菜单中的「AI 面板」入口（`setMobileMenuOpen(false); setDashboardOpen(true)`）
- `<DashboardDrawer .../>` 整个渲染块
- `setDashboardOpen(false)` 在 `handleOpenAttentionItem` 等地方的副作用调用（变成不需要）

保留：
- `AttentionRail` 渲染本体
- `unreadItems` useMemo
- `handleOpenAttentionItem` 的核心逻辑（点击 rail item 跳 terminal dock + 高亮 todo），但去掉 `setDashboardOpen(false)` 那行
- `seenReplySessionIds` / `SEEN_REPLY_STORAGE_KEY` —— 用 grep 判定是否还有别的消费者；若**仅**由 AttentionHub 用，可一并删

## `web/src/dock/AttentionRail.tsx`

- 删除 prop `onOpenDashboard`
- 删除中央"数字球"按钮（即文件中的 `<button className="attention-rail__count">…`），保留头像列表
- 删除「+N 更多」按钮中 `onClick={onOpenDashboard}` 的行为：可以整个删掉「+N」按钮，或保留为不可点的展示（推荐删，因为没有"展开全部"的下游了）
- `count === 0` 分支保留（依然渲染 8px 占位细线）

## `web/src/api.ts`

- 删除 `getSessionStats` 和 `SessionStats` 类型导出 —— 如果除了 `KpiStrip` 外没有其它消费者
- 删除 `getResourceUsage` 之类资源占用相关导出 —— 同上判定
- 任何仅被上述 API 消费的 helper / 类型，一并清

## `web/src/replyHub.ts`

- 检查 `buildAttentionItems` / `AttentionItem` / `AttentionKind` / `countAttentionItems` 这几个 export 是否仅由 dashboard 消费：是 → 删；否 → 保留
- `buildUnreadSessionItems` / `UnreadSessionItem` 必须保留（AttentionRail 仍在用）

## `web/src/store/aiSessionStore.ts`

- 若 store 里有专为 `KpiStrip` / `LiveList` 设计的派生字段（如 `outputRates` 用法）只剩 dock 在用，保留；若只剩面板在用，可清。**默认保留**，不主动改 store。

# 数据流（改动后）

```
buildUnreadSessionItems(todos, liveSessions, lastSeenMap)
        │
        ▼ UnreadSessionItem[]
   AttentionRail (左侧头像列表) ── 点击 ──► handleOpenAttentionItem ──► TerminalDock.activate
```

`AttentionHub` 的三档分类视图（`pending_confirm` / `awaitingReply` / `review`）从全局聚合视图中消失。这些状态仍在 `useAiSessionStore` 中存活、仍驱动 `TerminalDock` 卡片上的状态徽章和单 session 行为；只是不再有一个聚合面板把它们列出来。

# 边界 & 异常

- **未读 0** + 无运行中 session：主工作台只剩四象限 + 顶栏。无任何"打开面板"入口残留。
- **TS 编译**：删 import / state / handler 后，`useDrawerStack` 的 stack 类型如果是字面量联合（`'dashboard' | ...`），需要同步删掉 `'dashboard'` 项。grep 一下确认。
- **测试**：`web/src/__tests__/` 或对应位置如有针对 dashboard 的单元测试，一并删。`vitest run` 不应有遗留引用。
- **CSS**：`dashboard.css` 删除后，确认没有任何其他文件 `import './dashboard/dashboard.css'`。
- **playwright / E2E**：若有针对「AI 面板」按钮的脚本，需调整或删除（grep `AI 面板` / `dashboardOpen` / `dash-` 类名）。

# 验收清单

- [ ] `web/src/dashboard/` 目录不存在
- [ ] `TodoManage.tsx` 中无 `dashboardOpen` / `DashboardDrawer` / 「AI 面板」字样
- [ ] mobile 菜单中无「AI 面板」选项
- [ ] `AttentionRail` 不再有中央数字球按钮，只保留头像列表
- [ ] `AttentionRail` 不接收 `onOpenDashboard` prop
- [ ] `npm run build`（在 `web/` 目录）通过，无 unused import / unused var 警告
- [ ] `npm test` / `vitest run`（项目根 + `web/`）全部通过
- [ ] 手动回归：未读 session 出现 → AttentionRail 头像点击 → 跳 TerminalDock → 高亮对应 todo，链路正常
- [ ] 手动回归：四象限主页 + dock 行为无视觉/交互回归

# 风险

1. **聚合视图丢失**：「待交互（pending_confirm）」「待验收（review）」两类的全局列表彻底消失。如果用户依赖这两个 chip 做批量处理，需要后续补回（建议：在每个 todo 卡上加状态角标，但本期不做）。
2. **`replyHub.ts` 类型残留**：`AttentionKind` / `AttentionItem` 可能被别的文件间接依赖（如类型 union 出现在 store / api 层）。删之前必须 grep 一遍，保守起见可以**先只删 dashboard 内部使用、保留 replyHub 不动**作为最小爆炸半径方案。
3. **`useDrawerStack` 共享 store**：删 `'dashboard'` 这个 key 的时候，如果该 store 用字面量联合类型，可能影响其他 drawer 的类型推断。

# 实施顺序建议

1. 先删 `TodoManage.tsx` 的 `DashboardDrawer` 渲染和 `dashboardOpen` state（让面板不再可见）
2. 删顶栏 + mobile 菜单「AI 面板」按钮
3. 删 `AttentionRail` 的中央数字球 + `onOpenDashboard` prop + TodoManage 传入处
4. 删 `web/src/dashboard/` 目录
5. grep 检查 `buildAttentionItems` / `getSessionStats` / 相关类型，按"仅由 dashboard 消费"原则清理
6. 跑 `npm run build` + 测试 + 手动回归
