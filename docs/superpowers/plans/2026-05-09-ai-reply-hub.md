# AI Reply Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global AI Reply Hub that shows sessions needing attention, opens them from one list, scrolls to the matching Claude Code area, and lets completed replies be marked seen.

**Architecture:** Keep attention-state derivation client-side. Add a pure `replyHub` module for deriving attention items and managing local seen-session IDs, render those items in the existing Dashboard, and keep navigation/scroll/filter state in `TodoManage.tsx` where todo visibility and terminal expansion already live.

**Tech Stack:** React 18, TypeScript, Ant Design, Zustand live session store, Vitest for pure unit tests, Vite build for type/bundle verification.

---

## File structure

- Create `web/src/replyHub.ts`
  - Pure attention-item derivation from `Todo[]`, live sessions, and seen session IDs.
  - LocalStorage parse/serialize helpers for `quadtodo:seenAiReplies`.
  - Shared types used by `TodoManage.tsx` and Dashboard components.
- Create `test/reply-hub.test.ts`
  - Unit tests for pending-confirm items, completed review items, seen filtering, duplicate prevention, sorting, and storage parsing.
- Create `web/src/dashboard/AttentionHub.tsx`
  - Dashboard section that displays summary counts, filters, item cards, `定位并展开`, `标记已看`, and `清空已完成`.
- Modify `web/src/dashboard/DashboardDrawer.tsx`
  - Accept attention hub props and render `AttentionHub` above the existing KPI/live-session sections.
- Modify `web/src/dashboard/dashboard.css`
  - Add high-fidelity styles for the attention hub cards, summary tiles, filter chips, and empty state.
- Modify `web/src/TodoManage.tsx`
  - Load/save seen reply IDs.
  - Derive attention items from `todos` and `useAiSessionStore`.
  - Render the floating `待处理回复 N` entry.
  - Implement jump-to-session behavior: adjust filters, switch view, show terminal, scroll, and highlight.
- Modify `web/src/TodoManage.css`
  - Add floating-entry styles and temporary target highlight animation.

Do not change backend routes, database schema, PTY logic, or xterm lifecycle.

---

### Task 1: Add pure reply hub derivation and storage helpers

**Files:**
- Create: `web/src/replyHub.ts`
- Test: `test/reply-hub.test.ts`

- [ ] **Step 1: Write failing unit tests for attention derivation**

Create `test/reply-hub.test.ts` with this content:

```ts
import { describe, expect, it } from 'vitest'
import type { AiSession, Todo } from '../web/src/api.ts'
import {
  buildAttentionItems,
  countAttentionItems,
  parseSeenReplySessionIds,
  serializeSeenReplySessionIds,
} from '../web/src/replyHub.ts'
import type { SessionMeta } from '../web/src/store/aiSessionStore.ts'

function session(input: Partial<AiSession> & { sessionId: string }): AiSession {
  return {
    sessionId: input.sessionId,
    tool: input.tool || 'claude',
    nativeSessionId: input.nativeSessionId ?? null,
    cwd: input.cwd ?? null,
    status: input.status || 'done',
    startedAt: input.startedAt ?? 1000,
    completedAt: input.completedAt ?? 2000,
    prompt: input.prompt || 'prompt',
    label: input.label,
  }
}

function todo(input: Partial<Todo> & { id: string; title: string }): Todo {
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description || '',
    quadrant: input.quadrant || 1,
    status: input.status || 'todo',
    dueDate: input.dueDate ?? null,
    workDir: input.workDir ?? null,
    brainstorm: input.brainstorm ?? false,
    appliedTemplateIds: input.appliedTemplateIds || [],
    sortOrder: input.sortOrder ?? 0,
    aiSession: input.aiSession ?? null,
    aiSessions: input.aiSessions || [],
    recurringRuleId: input.recurringRuleId ?? null,
    instanceDate: input.instanceDate ?? null,
    completedAt: input.completedAt ?? null,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
  }
}

function live(input: Partial<SessionMeta> & { sessionId: string; todoId: string }): SessionMeta {
  return {
    sessionId: input.sessionId,
    todoId: input.todoId,
    todoTitle: input.todoTitle || 'Live todo',
    quadrant: input.quadrant || 2,
    tool: input.tool || 'claude',
    status: input.status || 'running',
    autoMode: input.autoMode ?? null,
    nativeSessionId: input.nativeSessionId ?? null,
    cwd: input.cwd ?? null,
    startedAt: input.startedAt ?? 1000,
    completedAt: input.completedAt ?? null,
    lastOutputAt: input.lastOutputAt ?? null,
    outputBytesTotal: input.outputBytesTotal ?? 0,
  }
}

describe('buildAttentionItems', () => {
  it('creates a待交互 item for live pending_confirm sessions', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Fix login', quadrant: 1 })],
      liveSessions: [live({ sessionId: 's-live', todoId: 'todo-1', status: 'pending_confirm', lastOutputAt: 3000 })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'interaction:s-live',
      kind: 'interaction',
      sessionId: 's-live',
      todoId: 'todo-1',
      todoTitle: 'Fix login',
      quadrant: 1,
      tool: 'claude',
      timestamp: 3000,
    })
  })

  it('creates a待验收 item for ai_done todos with done sessions', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-2', title: 'Refactor terminal', status: 'ai_done', quadrant: 2, aiSessions: [session({ sessionId: 's-done', completedAt: 4000 })] })],
      liveSessions: [],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'review:s-done',
      kind: 'review',
      sessionId: 's-done',
      todoId: 'todo-2',
      todoTitle: 'Refactor terminal',
      quadrant: 2,
      timestamp: 4000,
    })
  })

  it('filters completed review items that have been marked seen', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-2', title: 'Refactor terminal', status: 'ai_done', aiSessions: [session({ sessionId: 's-done' })] })],
      liveSessions: [],
      seenSessionIds: new Set(['s-done']),
    })

    expect(items).toEqual([])
  })

  it('does not remove待交互 items when their session id is marked seen', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs input' })],
      liveSessions: [live({ sessionId: 's-pending', todoId: 'todo-1', status: 'pending_confirm' })],
      seenSessionIds: new Set(['s-pending']),
    })

    expect(items.map(item => item.kind)).toEqual(['interaction'])
  })

  it('prevents duplicate items when the same session appears as pending and in todo history', () => {
    const items = buildAttentionItems({
      todos: [todo({ id: 'todo-1', title: 'Needs input', status: 'ai_done', aiSessions: [session({ sessionId: 's-same', status: 'done' })] })],
      liveSessions: [live({ sessionId: 's-same', todoId: 'todo-1', status: 'pending_confirm' })],
      seenSessionIds: new Set(),
    })

    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('interaction')
  })

  it('sorts待交互 before待验收, then by newest timestamp', () => {
    const items = buildAttentionItems({
      todos: [
        todo({ id: 'todo-1', title: 'Old review', status: 'ai_done', aiSessions: [session({ sessionId: 's-old', completedAt: 1000 })] }),
        todo({ id: 'todo-2', title: 'New review', status: 'ai_done', aiSessions: [session({ sessionId: 's-new', completedAt: 5000 })] }),
      ],
      liveSessions: [live({ sessionId: 's-pending', todoId: 'todo-3', todoTitle: 'Pending', status: 'pending_confirm', lastOutputAt: 2000 })],
      seenSessionIds: new Set(),
    })

    expect(items.map(item => item.sessionId)).toEqual(['s-pending', 's-new', 's-old'])
  })

  it('counts待交互 and待验收 separately', () => {
    const counts = countAttentionItems([
      { id: 'interaction:a', kind: 'interaction', sessionId: 'a', todoId: 'ta', todoTitle: 'A', quadrant: 1, tool: 'claude', timestamp: 1 },
      { id: 'review:b', kind: 'review', sessionId: 'b', todoId: 'tb', todoTitle: 'B', quadrant: 2, tool: 'codex', timestamp: 2 },
      { id: 'review:c', kind: 'review', sessionId: 'c', todoId: 'tc', todoTitle: 'C', quadrant: 3, tool: 'cursor', timestamp: 3 },
    ])

    expect(counts).toEqual({ total: 3, interaction: 1, review: 2 })
  })
})

describe('seen reply storage helpers', () => {
  it('parses array storage values', () => {
    expect([...parseSeenReplySessionIds('["a","b",3,null]')]).toEqual(['a', 'b'])
  })

  it('parses object storage values for forward compatibility', () => {
    expect([...parseSeenReplySessionIds('{"a":171,"b":172}')]).toEqual(['a', 'b'])
  })

  it('returns an empty set for invalid storage', () => {
    expect(parseSeenReplySessionIds('not json')).toEqual(new Set())
  })

  it('serializes seen ids as a stable sorted array', () => {
    expect(serializeSeenReplySessionIds(new Set(['b', 'a']))).toBe('["a","b"]')
  })
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
npx vitest run test/reply-hub.test.ts
```

Expected: FAIL because `web/src/replyHub.ts` does not exist.

- [ ] **Step 3: Implement the pure reply hub module**

Create `web/src/replyHub.ts` with this content:

```ts
import type { AiSession, AiTool, Quadrant, Todo } from './api'
import type { SessionMeta } from './store/aiSessionStore'

export const SEEN_REPLY_STORAGE_KEY = 'quadtodo:seenAiReplies'

export type AttentionKind = 'interaction' | 'review'

export interface AttentionItem {
  id: string
  kind: AttentionKind
  sessionId: string
  todoId: string
  todoTitle: string
  quadrant: Quadrant
  tool: AiTool
  timestamp: number
  label?: string
}

export interface AttentionCounts {
  total: number
  interaction: number
  review: number
}

export interface BuildAttentionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  seenSessionIds: Set<string>
}

function normalizeTimestamp(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function uniqueTodoSessions(todo: Todo): AiSession[] {
  const byId = new Map<string, AiSession>()
  for (const session of [todo.aiSession, ...(todo.aiSessions || [])]) {
    if (!session?.sessionId) continue
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function buildAttentionItems({ todos, liveSessions, seenSessionIds }: BuildAttentionItemsInput): AttentionItem[] {
  const todoById = new Map(todos.map(todo => [todo.id, todo]))
  const items: AttentionItem[] = []
  const usedSessionIds = new Set<string>()

  for (const live of liveSessions) {
    if (live.status !== 'pending_confirm') continue
    const todo = todoById.get(live.todoId)
    const title = todo?.title || live.todoTitle || '(无标题)'
    items.push({
      id: `interaction:${live.sessionId}`,
      kind: 'interaction',
      sessionId: live.sessionId,
      todoId: live.todoId,
      todoTitle: title,
      quadrant: todo?.quadrant || live.quadrant,
      tool: live.tool,
      timestamp: normalizeTimestamp(live.lastOutputAt, live.completedAt, live.startedAt),
    })
    usedSessionIds.add(live.sessionId)
  }

  for (const todo of todos) {
    const todoIsAwaitingReview = todo.status === 'ai_done'
    const todoIsAwaitingInteraction = todo.status === 'ai_pending'

    for (const session of uniqueTodoSessions(todo)) {
      if (usedSessionIds.has(session.sessionId)) continue

      if (todoIsAwaitingInteraction && session.status === 'pending_confirm') {
        items.push({
          id: `interaction:${session.sessionId}`,
          kind: 'interaction',
          sessionId: session.sessionId,
          todoId: todo.id,
          todoTitle: todo.title || '(无标题)',
          quadrant: todo.quadrant,
          tool: session.tool,
          timestamp: normalizeTimestamp(session.completedAt, session.startedAt, todo.updatedAt),
          label: session.label,
        })
        usedSessionIds.add(session.sessionId)
        continue
      }

      if (!todoIsAwaitingReview) continue
      if (session.status !== 'done') continue
      if (seenSessionIds.has(session.sessionId)) continue

      items.push({
        id: `review:${session.sessionId}`,
        kind: 'review',
        sessionId: session.sessionId,
        todoId: todo.id,
        todoTitle: todo.title || '(无标题)',
        quadrant: todo.quadrant,
        tool: session.tool,
        timestamp: normalizeTimestamp(session.completedAt, session.startedAt, todo.updatedAt),
        label: session.label,
      })
      usedSessionIds.add(session.sessionId)
    }
  }

  return items.sort((a, b) => {
    const rank = (item: AttentionItem) => item.kind === 'interaction' ? 0 : 1
    const rankDiff = rank(a) - rank(b)
    if (rankDiff !== 0) return rankDiff
    return b.timestamp - a.timestamp
  })
}

export function countAttentionItems(items: AttentionItem[]): AttentionCounts {
  let interaction = 0
  let review = 0
  for (const item of items) {
    if (item.kind === 'interaction') interaction++
    else review++
  }
  return { total: interaction + review, interaction, review }
}

export function parseSeenReplySessionIds(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.filter((value): value is string => typeof value === 'string' && value.length > 0))
    if (parsed && typeof parsed === 'object') return new Set(Object.keys(parsed).filter(Boolean))
    return new Set()
  } catch {
    return new Set()
  }
}

export function serializeSeenReplySessionIds(ids: Set<string>): string {
  return JSON.stringify([...ids].filter(Boolean).sort())
}
```

- [ ] **Step 4: Run tests to verify the module passes**

Run:

```bash
npx vitest run test/reply-hub.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing backend tests for a regression check**

Run:

```bash
npm test -- --runInBand
```

Expected: If Vitest rejects `--runInBand`, run `npm test` instead. Expected final result: all tests pass.

- [ ] **Step 6: Checkpoint**

If the execution session has explicit user permission to commit, run:

```bash
git add web/src/replyHub.ts test/reply-hub.test.ts
git commit -m "feat(web): derive AI reply hub items"
```

If commits are not authorized, do not commit; continue with the next task and report the checkpoint in the final summary.

---

### Task 2: Render the attention hub inside the Dashboard

**Files:**
- Create: `web/src/dashboard/AttentionHub.tsx`
- Modify: `web/src/dashboard/DashboardDrawer.tsx`
- Modify: `web/src/dashboard/dashboard.css`

- [ ] **Step 1: Create the Dashboard attention component**

Create `web/src/dashboard/AttentionHub.tsx` with this content:

```tsx
import React, { useMemo, useState } from 'react'
import { Button, Empty, Space, Tag, Tooltip } from 'antd'
import { AimOutlined, CheckCircleOutlined, ClearOutlined } from '@ant-design/icons'
import type { AttentionItem, AttentionKind } from '../replyHub'
import { countAttentionItems } from '../replyHub'

const QUADRANT_LABEL: Record<number, string> = { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3' }
const QUADRANT_COLOR: Record<number, string> = { 1: '#ef4444', 2: '#3b82f6', 3: '#f59e0b', 4: '#64748b' }

function formatAttentionTime(timestamp: number): string {
  if (!timestamp) return '刚刚'
  const diffMs = Math.max(0, Date.now() - timestamp)
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

function kindText(kind: AttentionKind): string {
  return kind === 'interaction' ? '待交互' : '待验收'
}

function toolText(tool: string): string {
  if (tool === 'claude') return 'Claude Code'
  if (tool === 'codex') return 'Codex'
  if (tool === 'cursor') return 'Cursor'
  return tool
}

export default function AttentionHub({
  items,
  onOpen,
  onMarkSeen,
  onClearReview,
}: {
  items: AttentionItem[]
  onOpen?: (item: AttentionItem) => void
  onMarkSeen?: (sessionId: string) => void
  onClearReview?: (sessionIds: string[]) => void
}) {
  const [filter, setFilter] = useState<'all' | AttentionKind>('all')
  const counts = useMemo(() => countAttentionItems(items), [items])
  const visibleItems = filter === 'all' ? items : items.filter(item => item.kind === filter)
  const reviewSessionIds = items.filter(item => item.kind === 'review').map(item => item.sessionId)

  return (
    <section className="dash-attention-section">
      <div className="dash-section-head">
        <span className="dash-section-title">
          <span className="dot" style={{ background: '#f97316' }} />
          待处理 AI 会话
        </span>
        {reviewSessionIds.length > 0 && (
          <Button
            size="small"
            type="text"
            icon={<ClearOutlined />}
            onClick={() => onClearReview?.(reviewSessionIds)}
          >
            清空已完成
          </Button>
        )}
      </div>

      <div className="dash-attention-summary">
        <button type="button" className={`dash-attention-summary-card ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          <strong>{counts.total}</strong>
          <span>全部</span>
        </button>
        <button type="button" className={`dash-attention-summary-card review ${filter === 'review' ? 'active' : ''}`} onClick={() => setFilter('review')}>
          <strong>{counts.review}</strong>
          <span>待验收</span>
        </button>
        <button type="button" className={`dash-attention-summary-card interaction ${filter === 'interaction' ? 'active' : ''}`} onClick={() => setFilter('interaction')}>
          <strong>{counts.interaction}</strong>
          <span>待交互</span>
        </button>
      </div>

      {visibleItems.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理 AI 会话" />
      ) : (
        <div className="dash-attention-list">
          {visibleItems.map(item => {
            const qColor = QUADRANT_COLOR[item.quadrant] || QUADRANT_COLOR[4]
            return (
              <div key={item.id} className={`dash-attention-card ${item.kind}`}>
                <div className="dash-attention-accent" style={{ background: qColor }} />
                <div className="dash-attention-main">
                  <div className="dash-attention-title-row">
                    <Tag color={item.kind === 'interaction' ? 'warning' : 'orange'}>{kindText(item.kind)}</Tag>
                    <Tag style={{ color: qColor, borderColor: `${qColor}55`, background: `${qColor}12` }}>{QUADRANT_LABEL[item.quadrant]}</Tag>
                    <span className="dash-attention-title" title={item.todoTitle}>{item.todoTitle}</span>
                  </div>
                  <div className="dash-attention-meta">
                    <span>{toolText(item.tool)}</span>
                    {item.label && <span>· {item.label}</span>}
                    <span>· {formatAttentionTime(item.timestamp)}</span>
                  </div>
                  <Space size={6} className="dash-attention-actions">
                    <Button size="small" type="primary" icon={<AimOutlined />} onClick={() => onOpen?.(item)}>
                      定位并展开
                    </Button>
                    {item.kind === 'review' && (
                      <Tooltip title="只从待处理列表移除，不改变 todo 状态">
                        <Button size="small" icon={<CheckCircleOutlined />} onClick={() => onMarkSeen?.(item.sessionId)}>
                          标记已看
                        </Button>
                      </Tooltip>
                    )}
                  </Space>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Wire the component into DashboardDrawer**

Modify `web/src/dashboard/DashboardDrawer.tsx`:

1. Add imports near the top:

```tsx
import AttentionHub from './AttentionHub'
import type { AttentionItem } from '../replyHub'
```

2. Replace the `DashboardBody` signature and props block with:

```tsx
function DashboardBody({ open, attentionItems, onOpenAttentionItem, onMarkAttentionSeen, onClearReviewAttention, onOpenTerminal, onStop }: {
  open: boolean
  attentionItems: AttentionItem[]
  onOpenAttentionItem?: (item: AttentionItem) => void
  onMarkAttentionSeen?: (sessionId: string) => void
  onClearReviewAttention?: (sessionIds: string[]) => void
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
```

3. In `DashboardBody`, render `AttentionHub` immediately after `<KpiStrip />`:

```tsx
      <AttentionHub
        items={attentionItems}
        onOpen={onOpenAttentionItem}
        onMarkSeen={onMarkAttentionSeen}
        onClearReview={onClearReviewAttention}
      />
```

4. Replace the exported component parameter destructuring with:

```tsx
export default function DashboardDrawer({
  open,
  onClose,
  attentionItems = [],
  onOpenAttentionItem,
  onMarkAttentionSeen,
  onClearReviewAttention,
  onOpenTerminal,
  onStop,
}: {
  open: boolean
  onClose: () => void
  attentionItems?: AttentionItem[]
  onOpenAttentionItem?: (item: AttentionItem) => void
  onMarkAttentionSeen?: (sessionId: string) => void
  onClearReviewAttention?: (sessionIds: string[]) => void
  onOpenTerminal?: (sessionId: string, todoId: string) => void
  onStop?: (sessionId: string) => void
}) {
```

5. Replace the `body` assignment with:

```tsx
  const body = (
    <DashboardBody
      open={open}
      attentionItems={attentionItems}
      onOpenAttentionItem={onOpenAttentionItem}
      onMarkAttentionSeen={onMarkAttentionSeen}
      onClearReviewAttention={onClearReviewAttention}
      onOpenTerminal={onOpenTerminal}
      onStop={onStop}
    />
  )
```

- [ ] **Step 3: Add Dashboard attention styles**

Append this CSS to `web/src/dashboard/dashboard.css`:

```css
/* ─── Attention Hub ─── */
.dash-attention-section {
  border: 1px solid #fed7aa;
  border-radius: 14px;
  background: linear-gradient(180deg, #fff7ed 0%, #ffffff 76%);
  padding: 12px;
}

.dash-attention-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.dash-attention-summary-card {
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #ffffff;
  padding: 10px;
  text-align: left;
  cursor: pointer;
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

.dash-attention-summary-card:hover,
.dash-attention-summary-card.active {
  border-color: #fb923c;
  box-shadow: 0 6px 16px rgba(249, 115, 22, 0.12);
  transform: translateY(-1px);
}

.dash-attention-summary-card strong {
  display: block;
  color: #0f172a;
  font-size: 22px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.dash-attention-summary-card span {
  color: #64748b;
  font-size: 12px;
}

.dash-attention-summary-card.review.active { border-color: #fb923c; }
.dash-attention-summary-card.interaction.active { border-color: #f59e0b; }

.dash-attention-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.dash-attention-card {
  display: grid;
  grid-template-columns: 4px 1fr;
  gap: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #ffffff;
  overflow: hidden;
}

.dash-attention-card.review {
  border-color: #fed7aa;
  background: #fff7ed;
}

.dash-attention-card.interaction {
  border-color: #fde68a;
  background: #fffbeb;
}

.dash-attention-accent {
  grid-row: 1 / -1;
  width: 4px;
}

.dash-attention-main {
  min-width: 0;
  padding: 10px 10px 10px 0;
}

.dash-attention-title-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.dash-attention-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #0f172a;
  font-size: 13px;
  font-weight: 700;
}

.dash-attention-meta {
  margin-top: 4px;
  color: #64748b;
  font-size: 11px;
}

.dash-attention-actions {
  margin-top: 9px;
}

@media (max-width: 640px) {
  .dash-attention-summary {
    grid-template-columns: 1fr;
  }

  .dash-attention-title-row {
    flex-wrap: wrap;
  }
}
```

- [ ] **Step 4: Run the frontend build to catch type and CSS import errors**

Run:

```bash
npm run build:web
```

Expected: PASS. If it fails on exact TypeScript line numbers, fix the typed props in the files touched in this task and rerun.

- [ ] **Step 5: Checkpoint**

If the execution session has explicit user permission to commit, run:

```bash
git add web/src/dashboard/AttentionHub.tsx web/src/dashboard/DashboardDrawer.tsx web/src/dashboard/dashboard.css
git commit -m "feat(web): show AI reply hub in dashboard"
```

If commits are not authorized, do not commit; continue with the next task and report the checkpoint in the final summary.

---

### Task 3: Add floating entry, seen-state wiring, and jump-to-session behavior

**Files:**
- Modify: `web/src/TodoManage.tsx`
- Modify: `web/src/TodoManage.css`

- [ ] **Step 1: Add imports in TodoManage**

Modify `web/src/TodoManage.tsx` imports:

1. Add `useRef` to the React import:

```tsx
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
```

2. Add `BellOutlined` to the icon import list:

```tsx
  MenuOutlined, BellOutlined,
```

3. Add reply hub imports after the store import:

```tsx
import {
  AttentionItem,
  buildAttentionItems,
  countAttentionItems,
  parseSeenReplySessionIds,
  SEEN_REPLY_STORAGE_KEY,
  serializeSeenReplySessionIds,
} from './replyHub'
```

- [ ] **Step 2: Add state for seen replies and highlighted target**

In `TodoManage` after `const [sideBySideByTodo, setSideBySideByTodo] = useState<Record<string, string | null>>({})`, add:

```tsx
  const [seenReplySessionIds, setSeenReplySessionIds] = useState<Set<string>>(() => {
    try { return parseSeenReplySessionIds(localStorage.getItem(SEEN_REPLY_STORAGE_KEY)) }
    catch { return new Set() }
  })
  const [highlightTodoId, setHighlightTodoId] = useState<string | null>(null)
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
```

- [ ] **Step 3: Derive attention items and counts**

After the existing live-session polling effect (`useEffect` ending near `}, [setLiveSessions])`), add:

```tsx
  const liveSessions = useAiSessionStore(s => s.sessions)
  const attentionItems = useMemo(() => buildAttentionItems({
    todos,
    liveSessions: [...liveSessions.values()],
    seenSessionIds: seenReplySessionIds,
  }), [todos, liveSessions, seenReplySessionIds])
  const attentionCounts = useMemo(() => countAttentionItems(attentionItems), [attentionItems])
```

If this creates a hook-order lint concern because `useAiSessionStore` is already used earlier, keep both calls at the top level of `TodoManage`; do not put them inside conditions.

- [ ] **Step 4: Add seen-state handlers**

After `handleDashboardStop`, add:

```tsx
  const persistSeenReplySessionIds = useCallback((next: Set<string>) => {
    setSeenReplySessionIds(next)
    try { localStorage.setItem(SEEN_REPLY_STORAGE_KEY, serializeSeenReplySessionIds(next)) }
    catch { /* localStorage may be unavailable in private contexts */ }
  }, [])

  const handleMarkAttentionSeen = useCallback((sessionId: string) => {
    persistSeenReplySessionIds(new Set([...seenReplySessionIds, sessionId]))
  }, [persistSeenReplySessionIds, seenReplySessionIds])

  const handleClearReviewAttention = useCallback((sessionIds: string[]) => {
    persistSeenReplySessionIds(new Set([...seenReplySessionIds, ...sessionIds]))
  }, [persistSeenReplySessionIds, seenReplySessionIds])
```

- [ ] **Step 5: Implement jump-to-session handler**

After the handlers from Step 4, add:

```tsx
  const handleOpenAttentionItem = useCallback((item: AttentionItem) => {
    setDashboardOpen(false)
    setViewMode('list')
    setFilterStatus('')
    setKeyword('')
    setHiddenTerminalSessionIdByTodo(prev => ({ ...prev, [item.todoId]: null }))
    setCollapsedTerminalByTodo(prev => ({ ...prev, [item.todoId]: false }))
    setExpandedTerminal({ todoId: item.todoId, sessionId: item.sessionId })
    setOverlayTerminal(null)
    setHighlightTodoId(item.todoId)

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTodoId(null)
      highlightTimerRef.current = null
    }, 3000)

    window.setTimeout(() => {
      document.getElementById(`todo-card-${item.todoId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
  }, [])
```

Then add a cleanup effect after this handler:

```tsx
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    }
  }, [])
```

- [ ] **Step 6: Pass highlight state to todo cards**

Update `SortableTodoCardProps` to include:

```tsx
  highlightTodoId?: string | null
```

Update the `SortableTodoCard` parameter list to destructure `highlightTodoId`.

Replace the `cardClassName` assignment with:

```tsx
  const cardClassName = `todo-card quadrant-${todo.quadrant} ${isDragging ? 'dragging' : ''} ${todo.status === 'done' ? 'done' : ''} ${isSubtodo ? 'subtodo-card' : ''} ${highlightTodoId === todo.id ? 'attention-target-highlight' : ''}`
```

Add an `id` attribute to the top-level card `<div>`:

```tsx
      id={`todo-card-${todo.id}`}
```

When rendering child `SortableTodoCard`, add:

```tsx
                      highlightTodoId={highlightTodoId}
```

Update `QuadrantZoneProps` to include:

```tsx
  highlightTodoId?: string | null
```

Update `QuadrantZone` destructuring to include `highlightTodoId`, then pass it to each `SortableTodoCard` rendered inside `QuadrantZone`:

```tsx
              highlightTodoId={highlightTodoId}
```

In both priority-view and quadrant-view `SortableTodoCard` / `QuadrantZone` call sites, pass:

```tsx
                      highlightTodoId={highlightTodoId}
```

or for `QuadrantZone`:

```tsx
                highlightTodoId={highlightTodoId}
```

- [ ] **Step 7: Render the floating entry and wire Dashboard props**

Before the existing `<DashboardDrawer ... />` block in `TodoManage.tsx`, insert:

```tsx
      {attentionCounts.total > 0 && (
        <button
          type="button"
          className="todo-attention-fab"
          onClick={() => setDashboardOpen(true)}
          title="打开待处理 AI 会话"
        >
          <span className="todo-attention-fab-icon"><BellOutlined /></span>
          <span className="todo-attention-fab-text">
            <strong>待处理回复</strong>
            <small>{attentionCounts.review} 待验收 · {attentionCounts.interaction} 待交互</small>
          </span>
          <span className="todo-attention-fab-badge">{attentionCounts.total}</span>
        </button>
      )}
```

Replace the existing `DashboardDrawer` call with:

```tsx
      <DashboardDrawer
        open={dashboardOpen}
        onClose={() => setDashboardOpen(false)}
        attentionItems={attentionItems}
        onOpenAttentionItem={handleOpenAttentionItem}
        onMarkAttentionSeen={handleMarkAttentionSeen}
        onClearReviewAttention={handleClearReviewAttention}
        onOpenTerminal={handleDashboardOpenTerminal}
        onStop={handleDashboardStop}
      />
```

- [ ] **Step 8: Add floating entry and highlight styles**

Append this CSS to `web/src/TodoManage.css`:

```css
.todo-attention-fab {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 900;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 999px;
  padding: 10px 14px 10px 10px;
  color: #fff;
  background: linear-gradient(135deg, #1677ff 0%, #4f46e5 100%);
  box-shadow: 0 18px 42px rgba(22, 119, 255, 0.28);
  cursor: pointer;
}

.todo-attention-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 22px 48px rgba(22, 119, 255, 0.34);
}

.todo-attention-fab-icon {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.18);
  font-size: 16px;
}

.todo-attention-fab-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.15;
}

.todo-attention-fab-text strong {
  font-size: 13px;
  font-weight: 700;
}

.todo-attention-fab-text small {
  margin-top: 2px;
  font-size: 11px;
  font-weight: 500;
  opacity: 0.86;
}

.todo-attention-fab-badge {
  display: inline-grid;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 999px;
  color: #1677ff;
  background: #fff;
  font-size: 12px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.todo-card.attention-target-highlight {
  animation: todo-attention-highlight 3s ease-out;
  outline: 3px solid rgba(22, 119, 255, 0.28);
  box-shadow: 0 0 0 8px rgba(22, 119, 255, 0.10), 0 12px 30px rgba(15, 23, 42, 0.12);
}

@keyframes todo-attention-highlight {
  0% {
    outline-color: rgba(22, 119, 255, 0.52);
    box-shadow: 0 0 0 10px rgba(22, 119, 255, 0.18), 0 16px 36px rgba(15, 23, 42, 0.16);
  }
  100% {
    outline-color: rgba(22, 119, 255, 0.10);
    box-shadow: 0 0 0 0 rgba(22, 119, 255, 0), 0 4px 12px rgba(15, 23, 42, 0.06);
  }
}

@media (max-width: 640px) {
  .todo-attention-fab {
    right: 12px;
    bottom: 12px;
    padding: 9px 11px 9px 9px;
  }

  .todo-attention-fab-text small {
    display: none;
  }
}
```

- [ ] **Step 9: Run frontend build**

Run:

```bash
npm run build:web
```

Expected: PASS.

- [ ] **Step 10: Checkpoint**

If the execution session has explicit user permission to commit, run:

```bash
git add web/src/TodoManage.tsx web/src/TodoManage.css
git commit -m "feat(web): add floating AI reply hub entry"
```

If commits are not authorized, do not commit; continue with the next task and report the checkpoint in the final summary.

---

### Task 4: Validate end-to-end behavior manually

**Files:**
- No source file changes expected unless validation exposes a bug in files touched above.

- [ ] **Step 1: Run all focused automated checks**

Run:

```bash
npx vitest run test/reply-hub.test.ts
npm run build:web
```

Expected: both commands PASS.

- [ ] **Step 2: Start the app for manual UI validation**

Run:

```bash
npm run start
```

Expected: the CLI starts the local quadtodo server and prints or opens the local web app. If the server is already running, use the existing app window.

- [ ] **Step 3: Verify completed reply hub behavior**

In the browser:

1. Find or create a todo with an AI session that is in `ai_done` with a `done` session.
2. Confirm the bottom-right floating entry appears with count at least `1`.
3. Click the floating entry.
4. Confirm the Dashboard opens and the `待处理 AI 会话` section contains a `待验收` item for that todo.
5. Click `定位并展开`.
6. Confirm the Dashboard closes, the page switches to list view, the target todo is visible, the correct terminal/session is expanded, and the card highlights briefly.
7. Open the Dashboard again and click `标记已看` for the same item.
8. Confirm the item disappears and the floating count decreases.
9. Refresh the page.
10. Confirm the marked-seen item remains hidden.

- [ ] **Step 4: Verify pending interaction behavior**

In the browser:

1. Use a running AI session that reaches `pending_confirm`, or temporarily use an existing pending session if one is available.
2. Confirm the floating entry count includes the pending item.
3. Open the Dashboard and confirm the item is marked `待交互`.
4. Confirm no `标记已看` button appears on the `待交互` item.
5. Click `定位并展开` and confirm it scrolls to the correct terminal.
6. Resolve the pending prompt in the terminal.
7. Confirm the item disappears after the next live-session/todo refresh when the status is no longer pending.

- [ ] **Step 5: Verify no regressions in existing Dashboard and terminal behavior**

In the browser:

1. Open `AI 面板` from the toolbar and confirm live sessions still render.
2. Click a live session's existing terminal-open button and confirm it still opens the terminal modal/overlay path.
3. Start two sessions with `同时启动 Claude + Codex（并排）` on a todo and confirm side-by-side still renders.
4. Type into an expanded terminal and confirm input still reaches the session.

- [ ] **Step 6: Stop the dev server if this session started it**

If Step 2 started a foreground server, stop it with `Ctrl+C` in that terminal. If the server was already running before validation, leave it running.

- [ ] **Step 7: Final checkpoint**

If the execution session has explicit user permission to commit and there are source changes from validation fixes, run:

```bash
git status --short
git add web/src/replyHub.ts test/reply-hub.test.ts web/src/dashboard/AttentionHub.tsx web/src/dashboard/DashboardDrawer.tsx web/src/dashboard/dashboard.css web/src/TodoManage.tsx web/src/TodoManage.css
git commit -m "feat(web): add AI reply hub"
```

If commits are not authorized, do not commit; include changed files and validation results in the final summary.

---

## Self-review

- Spec coverage: the plan implements the floating count, Dashboard list, `定位并展开`, `标记已看`, `清空已完成`, localStorage persistence, filter/view adjustment, scroll/highlight behavior, and validation of existing Dashboard/terminal behavior.
- Placeholder scan: the plan contains concrete file paths, code blocks, commands, and expected results. It does not rely on undefined future work.
- Type consistency: `AttentionItem`, `AttentionKind`, `AttentionCounts`, storage helpers, and callback signatures are defined in `web/src/replyHub.ts` before being used by Dashboard and TodoManage tasks.
