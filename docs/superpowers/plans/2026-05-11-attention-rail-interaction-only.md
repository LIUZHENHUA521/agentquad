# AttentionRail 只展示「待确认」AI 会话 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让左侧 `AttentionRail` 在视觉与计数上彻底聚焦「待确认」（`kind === 'interaction'`）的 AI 会话，方案 B 全量落地。

**Architecture:** 仅修改视图层 `AttentionRail.tsx` 和它的调用方 `TodoManage.tsx`。`buildAttentionItems` / `countAttentionItems` / `DashboardDrawer` 全部保持原样，以保留 dashboard 抽屉的三类 chip 能力。

**Tech Stack:** React 18 + TypeScript + antd（已在项目中）；vitest（已配置在 repo 根 `vitest.config.js`，跑命令为 `npm test`）。

**Spec:** `docs/superpowers/specs/2026-05-11-attention-rail-interaction-only-design.md`

---

## 文件结构

| 路径 | 改动类型 | 责任 |
| --- | --- | --- |
| `web/src/dock/AttentionRail.tsx` | Modify | 视图层；过滤为 interaction、改 tooltip/计数源、改空态判定、移除 `unreadCount`/`hasNew` props |
| `web/src/TodoManage.tsx` | Modify | 调用方；移除给 rail 传的 `unreadCount`/`hasNew`，并删掉因此变成死代码的 `unreadCount` / `hasNewAttention` / `acknowledgedAttentionIds` 三处定义及其相关 `useEffect`、`useState`、二次声明的 `lastSeenMap` |
| `test/reply-hub.test.ts` | （无改动） | `countAttentionItems` 已被覆盖；无需新增测试 |

> 备注：项目根 `package.json` 当前存在未解决的合并冲突（不是本次工作引入的）。任何 git commit 都会被 git 拒绝，除非先解决该冲突。本计划中的 commit 步骤需要在执行前先确认仓库处于干净的可提交状态。

---

## Task 1：改造 `AttentionRail.tsx`

**Files:**
- Modify: `web/src/dock/AttentionRail.tsx`

- [ ] **Step 1：用以下完整内容覆盖 `web/src/dock/AttentionRail.tsx`**

```tsx
import React from 'react'
import { Tooltip } from 'antd'
import type { AttentionItem, AttentionCounts } from '../replyHub'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  items: AttentionItem[]
  counts: AttentionCounts
  onActivate: (item: AttentionItem) => void
  onOpenDashboard: () => void
}

export default function AttentionRail({ items, counts, onActivate, onOpenDashboard }: Props) {
  const isMobile = useIsMobile()
  if (isMobile) return null
  // 收起态：没有待确认会话时，rail 退化成 8px 细线
  if (counts.interaction === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  const interactionItems = items.filter(item => item.kind === 'interaction')
  const displayCount = counts.interaction > 99 ? '99+' : counts.interaction
  const tooltipTitle = `待确认：${counts.interaction}`

  return (
    <div className="attention-rail is-alerting">
      <button
        type="button"
        className="attention-rail__count"
        onClick={onOpenDashboard}
        title={tooltipTitle}
      >
        {displayCount}
      </button>
      <div className="attention-rail__items">
        {interactionItems.slice(0, 12).map(item => {
          const initial = (item.todoTitle || '?').charAt(0)
          return (
            <Tooltip key={item.id} title={item.todoTitle} placement="right">
              <button
                type="button"
                className={`attention-rail__item kind-${item.kind}`}
                onClick={() => onActivate(item)}
              >
                {initial}
              </button>
            </Tooltip>
          )
        })}
        {interactionItems.length > 12 && (
          <Tooltip title="更多待确认" placement="right">
            <button
              type="button"
              className="attention-rail__more"
              onClick={onOpenDashboard}
            >
              +{interactionItems.length - 12}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
```

要点核对：
- Props 从 6 个变 4 个（去掉 `unreadCount` / `hasNew`）
- `counts.interaction === 0` 即收起（不再看 `counts.total`）
- 列表来源由 `items.slice(0, 12)` 改为 `interactionItems.slice(0, 12)`
- tooltip 文案变更为「待确认：N」
- "+N 更多" tooltip 文案改为「更多待确认」
- `is-alerting` 直接固定（既然走到这里就 `counts.interaction > 0`）

- [ ] **Step 2：本地类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected：无 TypeScript 错误。如果报 "unreadCount" / "hasNew" 相关错误，说明调用方还未改 —— 这是 Task 2 的事，先继续。

> 如果 `tsc -b` 因为 incremental cache 报错，加 `--force`：`npx tsc -b --noEmit --force`

---

## Task 2：清理 `TodoManage.tsx` 调用方与死代码

**Files:**
- Modify: `web/src/TodoManage.tsx`（行号是本计划编写时的快照；以最新文件为准）

- [ ] **Step 1：删除 rail 调用方多余的 props**

定位（约第 1709–1716 行）：

```tsx
      <AttentionRail
        items={attentionItems}
        counts={attentionCounts}
        unreadCount={unreadCount}
        hasNew={hasNewAttention}
        onActivate={handleOpenAttentionItem}
        onOpenDashboard={() => setDashboardOpen(true)}
      />
```

改为：

```tsx
      <AttentionRail
        items={attentionItems}
        counts={attentionCounts}
        onActivate={handleOpenAttentionItem}
        onOpenDashboard={() => setDashboardOpen(true)}
      />
```

- [ ] **Step 2：删除因此变成死代码的 `unreadCount` memo（约 886–908 行）**

完整删除以下块：

```tsx
  const lastSeenMap = useUnreadStore(s => s.lastSeenAt)
  // 未读会话总数：合并 live（in-memory，最新）与 todo.aiSessions（持久化）的 lastTurnDoneAt，
  // 按 sessionId 去重取较新的那个时间，再与本地 lastSeenAt 比较。
  const unreadCount = useMemo(() => {
    const turnDoneBySid = new Map<string, number>()
    for (const live of liveSessionsMap.values()) {
      const ts = live.lastTurnDoneAt || 0
      if (ts > 0) turnDoneBySid.set(live.sessionId, ts)
    }
    for (const todo of todos) {
      for (const session of todo.aiSessions || []) {
        const ts = session.lastTurnDoneAt || 0
        if (!ts) continue
        const prev = turnDoneBySid.get(session.sessionId) || 0
        if (ts > prev) turnDoneBySid.set(session.sessionId, ts)
      }
    }
    let n = 0
    for (const [sid, ts] of turnDoneBySid) {
      if (isSessionUnread(ts, lastSeenMap.get(sid))) n++
    }
    return n
  }, [todos, liveSessionsMap, lastSeenMap])
```

注意：这里删的是 **第 886 行的二次声明** `lastSeenMap`。文件第 209 行还有一个同名声明，**不要动**——它被同文件的"行内未读小红点"使用（参见第 374 行 `isSessionUnread(turnDoneAt, lastSeenMap.get(session.sessionId))`）。

- [ ] **Step 3：删除 `acknowledgedAttentionIds` / `hasNewAttention` / 关联 effect（约 909–918 行）**

完整删除以下块：

```tsx
  const [acknowledgedAttentionIds, setAcknowledgedAttentionIds] = useState<Set<string>>(new Set())
  const hasNewAttention = useMemo(
    () => attentionItems.some(item => !acknowledgedAttentionIds.has(item.id)),
    [attentionItems, acknowledgedAttentionIds],
  )

  useEffect(() => {
    if (!dashboardOpen) return
    setAcknowledgedAttentionIds(new Set(attentionItems.map(i => i.id)))
  }, [dashboardOpen, attentionItems])
```

- [ ] **Step 4：检查是否还有 `unreadCount` / `hasNewAttention` / `acknowledgedAttentionIds` / `setAcknowledgedAttentionIds` 残留引用**

Run: `grep -n "unreadCount\b\|hasNewAttention\b\|acknowledgedAttentionIds\b\|setAcknowledgedAttentionIds\b" web/src/TodoManage.tsx`
Expected：输出为空。若仍有命中，回到对应位置一并清理。

> `unreadCount` 这个标识符在 `TranscriptView.tsx` 里另有同名局部变量（与本次无关），仅清理 `TodoManage.tsx`。

- [ ] **Step 5：检查 `isSessionUnread` 在 TodoManage 中是否仍被使用**

Run: `grep -n "isSessionUnread" web/src/TodoManage.tsx`
Expected：仍有命中（行内小红点用）。若意外变空，把 `import { useUnreadStore, isSessionUnread } from './store/unreadStore'` 里的 `isSessionUnread` 一并删掉。

- [ ] **Step 6：类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected：无错误。

---

## Task 3：验证

**Files:** （无新改动；只跑命令）

- [ ] **Step 1：运行单元测试**

Run（在 repo 根）：`npm test`
Expected：全部通过。`test/reply-hub.test.ts` 中既有的 `countAttentionItems` 用例验证 `interaction` / `awaitingReply` / `review` 计数仍然正确。

- [ ] **Step 2：构建前端**

Run（在 repo 根）：`npm run build:web`
Expected：`tsc -b` 通过，`vite build` 成功，无 TS / lint 错误。

- [ ] **Step 3：本地起前端 dev server，做视觉验证**

Run：`cd web && npm run dev`
打开浏览器后按以下用例核对：

| 状态 | 期望表现 |
| --- | --- |
| 无任何 attention 项（`counts.interaction === 0`，且无 awaiting/review） | 左 rail 是 8px 细线（不可见入口） |
| 只有 awaiting_reply / review，没有 interaction | 左 rail 仍是 8px 细线（**新行为：用户无法从 rail 看到这些**） |
| 有 1 个 interaction，没有其他 | 顶部红圈显示 `1`、tooltip `待确认：1`、按钮带脉冲动画；下方 1 个红边圆字徽章 |
| 有 3 个 interaction + 2 个 awaiting + 1 个 review | 顶部显示 `3`、tooltip `待确认：3`；下方只有 3 个红色徽章，**没有橙/蓝徽章** |
| 有 15 个 interaction | 下方 12 个红徽章 + 一个 `+3` 的「更多待确认」按钮 |
| 点击任一红徽章 | 正常打开对应 AI 会话（`onActivate` 行为不变） |
| 点击顶部红圈 | 打开 Dashboard 抽屉；抽屉里仍能看到「待交互 / 待回复 / 待验收」三类 chip 全部数据 |

不达预期则回 Task 1/2 修正。

- [ ] **Step 4：提交**

> 前置条件：`git status` 显示无 `package.json` 等未解决合并冲突。如有冲突，请先解决再 commit；本计划不修该冲突。

Run（在 repo 根）：
```bash
git add web/src/dock/AttentionRail.tsx web/src/TodoManage.tsx
git commit -m "feat(attention-rail): only show pending-confirm AI sessions

- Rail now filters to kind==='interaction' and counts.interaction
- Tooltip simplified to 待确认：N
- Empty/collapsed when counts.interaction === 0 (awaiting/review no longer surface)
- Drop unused unreadCount / hasNewAttention plumbing in TodoManage
- DashboardDrawer 三类 chip 行为保持不变"
```
Expected：commit 成功，工作区干净。
