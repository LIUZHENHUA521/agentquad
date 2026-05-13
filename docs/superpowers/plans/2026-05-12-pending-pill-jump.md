# Pending Pill 点击跳转 + 删除 AttentionRail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除桌面端左侧 AttentionRail，让顶栏 `pending` Pill 可点击展开 Popover 直接跳转到待处理会话。

**Architecture:** 扩展 `buildUnreadSessionItems` 把 `pending_confirm` live session 一并并入（带 `reason` 字段）。在 `TodoManage` 一处计算 `unreadItems` 并下发给 `TopbarDispatch`，由 Pill 包 AntD `Popover`（trigger=click），点击行复用既有 `handleOpenAttentionItem` 跳转流程。AttentionRail 文件与 CSS 整块删除。

**Tech Stack:** React 18 + TypeScript + AntD 5 (`Popover`) + zustand + Vitest（既有测试套件，仓库根目录 `npm test`）。

参考 spec：`docs/superpowers/specs/2026-05-12-pending-pill-jump-design.md`

---

## File Structure

**Modify:**
- `web/src/replyHub.ts` — 扩展 `buildUnreadSessionItems` + 给 `UnreadSessionItem` 添加可选 `reason` 字段
- `web/src/components/TopbarDispatch/TopbarDispatch.tsx` — 接收 props、去 Tooltip、加 Popover
- `web/src/components/TopbarDispatch/TopbarDispatch.css` — 新增 popover 行的可点击样式
- `web/src/TodoManage.tsx` — 把 `unreadItems` + `handleOpenAttentionItem` 透传给 `TopbarDispatch`，删除 AttentionRail 渲染与 import
- `web/src/TodoManage.css` — 删除 `.attention-rail*` 整段
- `test/reply-hub.test.ts` — 新增针对 pending_confirm + dedupe 的测试

**Delete:**
- `web/src/dock/AttentionRail.tsx`

---

## Task 1: 扩展 `buildUnreadSessionItems` 包含 `pending_confirm`（TDD）

**Files:**
- Modify: `web/src/replyHub.ts`
- Test: `test/reply-hub.test.ts`

`buildUnreadSessionItems` 当前只输出"未读回复"（`lastTurnDoneAt > lastSeen`）。本任务让它额外纳入所有 `status === 'pending_confirm'` 的 live session（即便 `lastTurnDoneAt` 没超过 `lastSeen` 也要保留），并给每项贴上 `reason: 'pending_confirm' | 'unread'`。同一 sessionId 在两类都命中时 reason 取 `pending_confirm` 且 timestamp 取最大。

时间戳来源（按优先级）：`lastTurnDoneAt → lastOutputAt → startedAt → 0`。这样 pending_confirm 没有 lastTurnDoneAt 时也能稳定排序，且对测试 deterministic（避免 `Date.now()`）。

- [ ] **Step 1: 在 `test/reply-hub.test.ts` 的 `describe('buildUnreadSessionItems', ...)` 内追加 4 个失败测试**

在该 describe 块（文件约 226 行起）的最后一个 `it` 之后插入：

```typescript
  it('includes live pending_confirm sessions even when lastTurnDoneAt is not newer than lastSeen', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs confirm' })],
      liveSessions: [live({
        sessionId: 's-pc',
        todoId: 'todo-1',
        todoTitle: 'Needs confirm',
        status: 'pending_confirm',
        lastOutputAt: 3000,
        lastTurnDoneAt: null,
      })],
      lastSeenMap: new Map(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'unread:s-pc',
      sessionId: 's-pc',
      todoId: 'todo-1',
      reason: 'pending_confirm',
      timestamp: 3000,
    })
  })

  it('tags purely unread reply items with reason="unread"', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Has unread', aiSessions: [session({ sessionId: 's-u', lastTurnDoneAt: 7000 })] })],
      liveSessions: [],
      lastSeenMap: new Map([['s-u', 1000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0].reason).toBe('unread')
  })

  it('dedupes when a session is both pending_confirm and unread, preferring reason=pending_confirm', () => {
    const items = buildUnreadSessionItems({
      todos: [todo({ id: 'todo-1', title: 'Both', aiSessions: [session({ sessionId: 's-both', lastTurnDoneAt: 5000 })] })],
      liveSessions: [live({
        sessionId: 's-both',
        todoId: 'todo-1',
        status: 'pending_confirm',
        lastTurnDoneAt: 5000,
        lastOutputAt: 6000,
      })],
      lastSeenMap: new Map([['s-both', 1000]]),
    })

    expect(items).toHaveLength(1)
    expect(items[0].reason).toBe('pending_confirm')
    expect(items[0].timestamp).toBe(6000)
  })

  it('sorts mixed reasons by timestamp desc', () => {
    const items = buildUnreadSessionItems({
      todos: [
        todo({ id: 'todo-a', title: 'A', aiSessions: [session({ sessionId: 's-unread-old', lastTurnDoneAt: 2000 })] }),
        todo({ id: 'todo-b', title: 'B' }),
      ],
      liveSessions: [live({
        sessionId: 's-pc-new',
        todoId: 'todo-b',
        status: 'pending_confirm',
        lastOutputAt: 9000,
      })],
      lastSeenMap: new Map(),
    })

    expect(items.map(i => i.sessionId)).toEqual(['s-pc-new', 's-unread-old'])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo && npx vitest run test/reply-hub.test.ts
```
Expected: 上述 4 个新 `it` 全部 FAIL。其它原有用例继续 PASS。

- [ ] **Step 3: 修改 `web/src/replyHub.ts`**

把文件**整体替换为**：

```typescript
import type { AiSession, AiTool, Quadrant, Todo } from './api'
import type { SessionMeta } from './store/aiSessionStore'

export type UnreadReason = 'pending_confirm' | 'unread'

export interface UnreadSessionItem {
  id: string
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
  reason?: UnreadReason
}

export interface BuildUnreadSessionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  lastSeenMap: Map<string, number>
}

function uniqueTodoSessions(todo: Todo): AiSession[] {
  const byId = new Map<string, AiSession>()
  for (const session of [todo.aiSession, ...(todo.aiSessions || [])]) {
    if (!session?.sessionId) continue
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function buildUnreadSessionItems({ todos, liveSessions, lastSeenMap }: BuildUnreadSessionItemsInput): UnreadSessionItem[] {
  const tsBySid = new Map<string, number>()
  const metaBySid = new Map<string, { todoId: string; todoTitle: string; quadrant: Quadrant; tool: AiTool; label?: string }>()
  const pendingConfirmSids = new Set<string>()

  for (const todo of todos) {
    for (const session of uniqueTodoSessions(todo)) {
      const ts = session.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(session.sessionId) || 0
        if (ts > prev) tsBySid.set(session.sessionId, ts)
      }
      if (!metaBySid.has(session.sessionId)) {
        metaBySid.set(session.sessionId, {
          todoId: todo.id,
          todoTitle: todo.title || '(无标题)',
          quadrant: todo.quadrant,
          tool: session.tool,
          label: session.label,
        })
      }
    }
  }

  for (const live of liveSessions) {
    if (live.status === 'pending_confirm') {
      pendingConfirmSids.add(live.sessionId)
      // pending_confirm 即便没有 lastTurnDoneAt 也要纳入，timestamp 用最新可得的活动时间
      const liveTs = live.lastTurnDoneAt || live.lastOutputAt || live.startedAt || 0
      const prev = tsBySid.get(live.sessionId) || 0
      if (liveTs > prev) tsBySid.set(live.sessionId, liveTs)
    } else {
      const ts = live.lastTurnDoneAt || 0
      if (ts > 0) {
        const prev = tsBySid.get(live.sessionId) || 0
        if (ts > prev) tsBySid.set(live.sessionId, ts)
      }
    }
    if (!metaBySid.has(live.sessionId)) {
      metaBySid.set(live.sessionId, {
        todoId: live.todoId,
        todoTitle: live.todoTitle || '(无标题)',
        quadrant: live.quadrant,
        tool: live.tool,
      })
    }
  }

  const items: UnreadSessionItem[] = []
  for (const [sid, ts] of tsBySid) {
    const isPendingConfirm = pendingConfirmSids.has(sid)
    if (!isPendingConfirm) {
      const lastSeen = lastSeenMap.get(sid) || 0
      if (ts <= lastSeen) continue
    }
    const meta = metaBySid.get(sid)
    if (!meta) continue
    items.push({
      id: `unread:${sid}`,
      sessionId: sid,
      timestamp: ts,
      reason: isPendingConfirm ? 'pending_confirm' : 'unread',
      ...meta,
    })
  }

  items.sort((a, b) => b.timestamp - a.timestamp)
  return items
}
```

注意：保留 spread `...meta` 在最后，避免覆盖 `id/sessionId/timestamp/reason`。`reason` 字段需在 spread 之前赋值以免被覆盖（meta 不含 reason，所以顺序怎么放都行，但保持显式）。

- [ ] **Step 4: 跑测试全部 PASS**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo && npx vitest run test/reply-hub.test.ts
```
Expected: 该文件全部用例 PASS（既有 + 新增 4 个）。

- [ ] **Step 5: Commit**

```
git add web/src/replyHub.ts test/reply-hub.test.ts
git commit -m "feat(replyHub): include pending_confirm sessions in buildUnreadSessionItems with reason tag"
```

---

## Task 2: 改造 `TopbarDispatch` 接收 props + Popover

**Files:**
- Modify: `web/src/components/TopbarDispatch/TopbarDispatch.tsx`

让 `TopbarDispatch` 接收 `unreadItems + onJump` 两个新 props。pending Pill 不再 hover 弹 Tooltip，改为包一层 AntD `Popover`（trigger=click），点击行调 `onJump(item)` 并自动关闭。

`activeList`（活跃会话 tooltip）保留原 hover Tooltip 行为不变。

`pendingCount` 显示口径切换为 `unreadItems.length`（不再依赖 `useDispatchStats().pendingCount`）。

- [ ] **Step 1: 整体替换 `web/src/components/TopbarDispatch/TopbarDispatch.tsx`**

```tsx
import { useState } from 'react'
import { Popover, Tooltip } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import type { UnreadSessionItem } from '../../replyHub'
import './TopbarDispatch.css'

export interface TopbarDispatchProps {
  unreadItems: UnreadSessionItem[]
  onJump: (item: UnreadSessionItem) => void
}

export function TopbarDispatch({ unreadItems, onJump }: TopbarDispatchProps) {
  const { activeCount, tokenSumLabel } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const [pendingOpen, setPendingOpen] = useState(false)

  const sessions = useAiSessionStore((s) => s.sessions)
  const activeList: { id: string; title: string; tool: string; status: string }[] = []
  sessions.forEach((session) => {
    if (session.status === 'running') {
      activeList.push({
        id: session.sessionId,
        title: session.todoTitle,
        tool: session.tool,
        status: session.status,
      })
    }
  })

  const pendingCount = unreadItems.length

  const handlePickItem = (item: UnreadSessionItem) => {
    setPendingOpen(false)
    onJump(item)
  }

  const pendingPopoverContent =
    pendingCount === 0 ? (
      <div className="topbar-tooltip-empty">No pending</div>
    ) : (
      <>
        <div className="topbar-tooltip-title">待处理 ({pendingCount})</div>
        <div className="topbar-pending-list">
          {unreadItems.map((item) => {
            const isPending = item.reason === 'pending_confirm'
            return (
              <button
                key={item.id}
                type="button"
                className="topbar-tooltip-row topbar-pending-row"
                onClick={() => handlePickItem(item)}
                data-testid="topbar-pending-row"
              >
                <span
                  className="topbar-tooltip-dot"
                  style={{ background: isPending ? 'var(--ai-pending-confirm)' : 'var(--ai-error)' }}
                />
                <span className="topbar-tooltip-name">{item.todoTitle}</span>
                <span className="topbar-tooltip-meta">
                  {item.tool} · {isPending ? '待批准' : '未读'}
                </span>
              </button>
            )
          })}
        </div>
      </>
    )

  return (
    <div className="topbar-dispatch">
      <div className="topbar-logo">
        <div className="topbar-logo-mark">A</div>
        <span>AgentQuad</span>
      </div>

      <StatPill
        icon="pulse-dot"
        iconColor="var(--ai-running)"
        value={activeCount}
        label="active"
        data-testid="stat-active"
        tooltip={
          activeList.length === 0 ? (
            <div className="topbar-tooltip-empty">No active sessions</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Active sessions ({activeList.length})</div>
              {activeList.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-running)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
            </>
          )
        }
      />

      <StatPill
        icon="arrow"
        value={tokenSumLabel}
        label="tok"
        data-testid="stat-tokens"
        tooltip={
          <>
            <div className="topbar-tooltip-title">Token usage</div>
            <div className="topbar-tooltip-row">
              <span className="topbar-tooltip-name">Total across active sessions</span>
              <span className="topbar-tooltip-meta">{tokenSumLabel}</span>
            </div>
          </>
        }
      />

      <Popover
        open={pendingOpen}
        onOpenChange={setPendingOpen}
        trigger="click"
        placement="bottomRight"
        overlayClassName="topbar-pending-popover"
        content={pendingPopoverContent}
      >
        <span data-testid="stat-pending-trigger">
          <StatPill
            variant={pendingCount > 0 ? 'alert' : 'default'}
            icon="pulse-dot"
            iconColor="var(--ai-pending-confirm)"
            value={pendingCount}
            label="pending"
            data-testid="stat-pending"
            onClick={() => setPendingOpen((v) => !v)}
          />
        </span>
      </Popover>

      <div className="topbar-spacer" />

      <button className="topbar-cmdk-btn" onClick={togglePalette} data-testid="topbar-cmdk-btn">
        <span className="topbar-cmdk-prefix">⌘</span>
        <span>Search or run a command</span>
        <kbd>⌘K</kbd>
      </button>

      <Tooltip title="历史会话找回">
        <button
          className="topbar-icon-btn"
          onClick={() => useDispatchStore.getState().signal('recover')}
          aria-label="Recover session"
          data-testid="topbar-recover-btn"
        >
          <SearchOutlined />
        </button>
      </Tooltip>
      <Tooltip title="Stats &amp; Reports">
        <button className="topbar-icon-btn" onClick={() => openDrawer('statsReports')} data-testid="topbar-stats-btn">📊</button>
      </Tooltip>
      <Tooltip title="Wiki">
        <button className="topbar-icon-btn" onClick={() => openDrawer('wiki')} data-testid="topbar-wiki-btn">📖</button>
      </Tooltip>
      <Tooltip title="Settings">
        <button className="topbar-icon-btn" onClick={() => openDrawer('settings')} data-testid="topbar-settings-btn">⚙</button>
      </Tooltip>
      <ThemeToggle />
    </div>
  )
}
```

要点：
- `useUnreadStore` 和 `isSessionUnread` 不再需要 → 删 import。
- Popover 通过外层 `<span data-testid="stat-pending-trigger">` 接管 ref（AntD 要求子元素能转发 ref；StatPill 是函数组件没 forwardRef，用 span 包一层是稳妥做法）。
- pending Pill 的 `tooltip` prop 去掉，改用 `onClick` 切换 `pendingOpen`。
- 保留 `stat-pending` testid 在 Pill 上不变；新增 `stat-pending-trigger`（外层）和 `topbar-pending-row`（列表项）便于 E2E。

- [ ] **Step 2: 跑类型检查**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo/web && npm run build 2>&1 | tail -40
```
Expected: 仍会因为 `TodoManage.tsx` 没传 props 而报错（"Property 'unreadItems' is missing"）。**这正是预期**，Task 4 会修复。如果出现别的类型错误，需要先修掉再继续。

- [ ] **Step 3: Commit（带破坏性变更，但下一任务会接上）**

```
git add web/src/components/TopbarDispatch/TopbarDispatch.tsx
git commit -m "feat(topbar): pending Pill switches from hover tooltip to click Popover (props-driven)"
```

---

## Task 3: 给 Popover 列表行加上可点击样式

**Files:**
- Modify: `web/src/components/TopbarDispatch/TopbarDispatch.css`

新增 `.topbar-pending-list` / `.topbar-pending-row` / `.topbar-pending-popover` 三个选择器。`.topbar-tooltip-*` 选择器保留（active/token Pill 仍在用）。

- [ ] **Step 1: 在 `web/src/components/TopbarDispatch/TopbarDispatch.css` 末尾追加**

```css
/* Pending Pill — click-to-jump Popover */
.topbar-pending-popover .ant-popover-inner {
  background: var(--surface-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  min-width: 280px;
  max-width: 360px;
}
.topbar-pending-popover .ant-popover-arrow {
  display: none;
}
.topbar-pending-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 320px;
  overflow-y: auto;
}
.topbar-pending-row {
  /* button reset */
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  text-align: left;
  width: 100%;
  cursor: pointer;
  padding: 6px 8px;
  margin: 0;
  transition: background var(--motion-fast) var(--ease-standard);
}
.topbar-pending-row:hover {
  background: var(--surface-2);
}
.topbar-pending-row:focus-visible {
  outline: none;
  border-color: var(--accent-electric);
}
```

- [ ] **Step 2: Commit**

```
git add web/src/components/TopbarDispatch/TopbarDispatch.css
git commit -m "style(topbar): popover row styling for pending pill list"
```

---

## Task 4: `TodoManage` 透传 props + 移除 AttentionRail 渲染

**Files:**
- Modify: `web/src/TodoManage.tsx`

把已有的 `unreadItems` + `handleOpenAttentionItem` 透传给 `TopbarDispatch`。同时把 `<AttentionRail .../>` 渲染和 import 移除。AttentionRail 文件本身保留到 Task 5 删除（保持每个 commit 可编译）。

- [ ] **Step 1: 删除 AttentionRail import**

把 `web/src/TodoManage.tsx:59` 这行：
```ts
import AttentionRail from './dock/AttentionRail'
```
**删除**。

- [ ] **Step 2: 删除 AttentionRail 渲染元素**

把 `web/src/TodoManage.tsx:1026-1029` 这段：
```tsx
      <AttentionRail
        items={unreadItems}
        onActivate={handleOpenAttentionItem}
      />
```
**删除**。

- [ ] **Step 3: 给 `<TopbarDispatch />` 加 props**

定位 `web/src/TodoManage.tsx` 中渲染 `<TopbarDispatch />` 的那一行（约 1032 行，原文为 `{!isMobile && <TopbarDispatch />}`），改为：

```tsx
      {!isMobile && (
        <TopbarDispatch
          unreadItems={unreadItems}
          onJump={handleOpenAttentionItem}
        />
      )}
```

- [ ] **Step 4: 跑类型检查 + 既有测试**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo/web && npm run build 2>&1 | tail -30
```
Expected: 编译通过（dist 输出）。

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo && npm test 2>&1 | tail -30
```
Expected: 全部测试 PASS。

- [ ] **Step 5: Commit**

```
git add web/src/TodoManage.tsx
git commit -m "feat(topbar): wire unreadItems/onJump into TopbarDispatch; stop rendering AttentionRail"
```

---

## Task 5: 删除 AttentionRail 文件 + CSS

**Files:**
- Delete: `web/src/dock/AttentionRail.tsx`
- Modify: `web/src/TodoManage.css`

**重要前置**：跑一次 grep 确保没有其它引用残留（Task 4 已 grep 过 `buildUnreadSessionItems`，这次再核 AttentionRail 本身的 import / 类名）。

- [ ] **Step 1: 确认无其它引用**

Run:
```
grep -rn "AttentionRail\|attention-rail" /Users/bytedance/Desktop/code/quadtodo/web/src --include="*.tsx" --include="*.ts" --include="*.css"
```
Expected: 只列出 `web/src/dock/AttentionRail.tsx` 自身和 `web/src/TodoManage.css` 里的 `.attention-rail*` 选择器。其它（包括 `TodoManage.tsx`）应为空。如有遗漏，回 Task 4 补。

- [ ] **Step 2: 删除 AttentionRail 文件**

Run:
```
git rm web/src/dock/AttentionRail.tsx
```

- [ ] **Step 3: 删除 `web/src/TodoManage.css` 中 AttentionRail 相关 CSS 块**

定位 `web/src/TodoManage.css` 第 752–802 行（包含 `/* === AttentionRail === */` 注释，以及 `.attention-rail`、`.attention-rail--empty`、`.attention-rail__items`、`.attention-rail__item`、`.attention-rail__more` 各选择器及其响应式补丁），**整块删除**。

并搜索 `web/src/TodoManage.css` 中其它残留 `.attention-rail*`（应只有该处一段；如有第二处 e.g. responsive override 在 ~966 行的 `.attention-rail__more { font-size: 11px; }`，一并删除）。

Run:
```
grep -n "attention-rail" /Users/bytedance/Desktop/code/quadtodo/web/src/TodoManage.css
```
Expected: 无输出。

- [ ] **Step 4: 再 grep 确认零残留**

Run:
```
grep -rn "AttentionRail\|attention-rail" /Users/bytedance/Desktop/code/quadtodo/web/src
```
Expected: 无输出。

- [ ] **Step 5: 编译 + 测试**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo/web && npm run build 2>&1 | tail -10 && cd /Users/bytedance/Desktop/code/quadtodo && npm test 2>&1 | tail -10
```
Expected: build 成功；vitest 全部 PASS。

- [ ] **Step 6: Commit**

```
git add web/src/dock/AttentionRail.tsx web/src/TodoManage.css
git commit -m "refactor: drop AttentionRail component and styles (replaced by pending pill popover)"
```

---

## Task 6: 最终验证

**Files:** —

- [ ] **Step 1: 全量 vitest**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo && npm test 2>&1 | tail -20
```
Expected: 全部 PASS，无 SKIP/FAIL。

- [ ] **Step 2: web 编译**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo/web && npm run build 2>&1 | tail -10
```
Expected: TypeScript + Vite 构建均成功。

- [ ] **Step 3: 手测（dev 服务器）**

Run:
```
cd /Users/bytedance/Desktop/code/quadtodo/web && npm run dev
```
（在另一终端或后台）打开浏览器至 dev 地址（通常 `http://localhost:5173`），手测清单：

1. 桌面端首屏不应再看到左侧 AttentionRail 列（也无 8px 空隙残留）。
2. 当存在 pending 会话时：顶栏 `N pending` Pill 为 alert 红色；点击后在右下方弹出 Popover，标题为"待处理 (N)"，每行包含 todo 标题 + `工具名 · 待批准|未读`。
3. 点击其中一行：Popover 关闭、SessionFocus 打开、对应 Todo 卡片滚动入视并高亮 3 秒。
4. 无 pending 时：Pill 显示 `0 pending`（default 灰）；点击 Popover 弹出空态文案 `No pending`。
5. Hover Pill **不再**弹出 tooltip（active / tok 两个 Pill 的 hover tooltip 保持不变）。
6. 调整窗口宽度至 ≤768px：进入移动布局，AttentionRail 仍不可见（保持原行为）。

- [ ] **Step 4: 若手测有问题：记录在 commit message 修复；通过即结束**

无新 commit。

---

## 回滚

每一步独立 commit，回滚单步即可。整体回滚：

```
git revert <task5-commit>..<task1-commit>
```

或在 task4 之前回滚足够保留 AttentionRail（但 Pill 已切换数据源，简单 revert 即可）。

## Self-Review 已通过

- [x] spec 第 3 节"组件改动"全部 → Task 2/3/4/5 覆盖
- [x] spec "数据源统一" → Task 1 覆盖（含 reason 字段、dedupe、排序测试）
- [x] spec "测试 → 单元 Vitest" → Task 1 Step 1 提供 4 个测试用例
- [x] 类型与接口名一致：`UnreadSessionItem.reason`、`onJump`、`unreadItems` 在所有 task 文本中拼写一致
- [x] 每个 task 都有具体代码，无 TODO/TBD 占位
- [x] 每个 task 末尾都有 commit 步骤
