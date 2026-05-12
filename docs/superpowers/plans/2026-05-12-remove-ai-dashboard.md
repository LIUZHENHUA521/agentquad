# 删除 AI 工作面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 彻底删除 AI 工作面板（`web/src/dashboard/` 目录 + `TodoManage.tsx` 中所有相关 state/handler/按钮 + `AttentionRail` 中央数字球），保留 `AttentionRail` 头像列表与 `TerminalDock` 主交互链路。

**Architecture:** 自顶向下三步删除：① 同时摘除 `TodoManage.tsx` 的全部消费点并重写 `AttentionRail.tsx`（两者类型互锁，必须原子化）；② 删 `web/src/dashboard/` 整目录；③ 清 `replyHub.ts` / `api.ts` 中失去消费者的 export。最后跑一次手动回归。每步独立可构建 + 一个 commit。后端 endpoint **不动**。

**Tech Stack:** React 18 + TypeScript（strict）+ Vite + AntD 5。前端无单元测试套件，主要靠 `tsc -b && vite build` 兜底 + 手动 dev 验证。

**Branch:** 工作直接在 `main`（与最近几次提交一致）。如需隔离 worktree，先 `git checkout -b remove-ai-dashboard` 再开工——本计划默认不创建分支。

**Spec:** `docs/superpowers/specs/2026-05-12-remove-ai-dashboard-design.md`

---

## 改动文件总览

修改：
- `web/src/TodoManage.tsx` — 摘除 dashboard 全部消费点
- `web/src/dock/AttentionRail.tsx` — 删数字球 + `onOpenDashboard` prop
- `web/src/replyHub.ts` — 删 `buildAttentionItems` 等失去消费者的 export
- `web/src/api.ts` — 删 `getSessionStats` + `SessionStats`

删除：
- `web/src/dashboard/` 整目录（8 个文件：`DashboardDrawer.tsx` / `KpiStrip.tsx` / `AttentionHub.tsx` / `LiveSessionCard.tsx` / `LiveGlanceTab.tsx` / `HistoryStatsTab.tsx` / `ResourceTab.tsx` / `dashboard.css`）

不动：
- 后端 `src/routes/ai-terminal.js` 中的 `/api/ai-terminal/stats` endpoint 及 `test/ai-terminal.route.test.js` 中相关测试
- `TerminalDock`、`useTerminalDockStore`、`useAiSessionStore`
- `useUnreadStore` / `isSessionUnread` / `buildUnreadSessionItems`

---

## Task A: 摘除 `TodoManage.tsx` 中所有 dashboard 消费点 + 重写 `AttentionRail`

**Why one task:** `AttentionRail` 当前把 `onOpenDashboard` 声明为必填 prop，`TodoManage` 又靠 `setDashboardOpen` 来传值。只动一头会让 `tsc -b` 失败，必须原子化。

**Files:**
- Modify: `web/src/TodoManage.tsx`
- Modify: `web/src/dock/AttentionRail.tsx`

- [ ] **Step A.1: 删 `DashboardOutlined` icon import**

`web/src/TodoManage.tsx:13` 当前是：

```tsx
  DashboardOutlined, FileTextOutlined, ExportOutlined,
```

改为：

```tsx
  FileTextOutlined, ExportOutlined,
```

- [ ] **Step A.2: 删 `DashboardDrawer` import**

`web/src/TodoManage.tsx:48` 整行删除：

```tsx
import DashboardDrawer from './dashboard/DashboardDrawer'
```

- [ ] **Step A.3: 收窄 `replyHub` import**

`web/src/TodoManage.tsx:52-60` 当前是：

```tsx
import {
  AttentionItem,
  buildAttentionItems,
  buildUnreadSessionItems,
  parseSeenReplySessionIds,
  SEEN_REPLY_STORAGE_KEY,
  serializeSeenReplySessionIds,
  type UnreadSessionItem,
} from './replyHub'
```

改为：

```tsx
import {
  buildUnreadSessionItems,
  type UnreadSessionItem,
} from './replyHub'
```

- [ ] **Step A.4: 删 `dashboardOpen` state**

`web/src/TodoManage.tsx:839` 整行删除：

```tsx
const [dashboardOpen, setDashboardOpen] = useState(false)
```

- [ ] **Step A.5: 删 `seenReplySessionIds` state**

`web/src/TodoManage.tsx:853-856` 当前是：

```tsx
  const [seenReplySessionIds, setSeenReplySessionIds] = useState<Set<string>>(() => {
    try { return parseSeenReplySessionIds(localStorage.getItem(SEEN_REPLY_STORAGE_KEY)) }
    catch { return new Set() }
  })
```

整块删除（4 行）。

- [ ] **Step A.6: 删 `useDrawerStack('dashboard', ...)`**

`web/src/TodoManage.tsx:891` 整行删除：

```tsx
useDrawerStack('dashboard', dashboardOpen, () => setDashboardOpen(false))
```

`useDrawerStack` 的其它注册行（`'settings'` / `'stats'` / `'wiki'` / `'report'` / `'template'` / `'transcript'` / `'pipeline'`）保留。

- [ ] **Step A.7: 删 `handleDashboardOpenTerminal` callback**

`web/src/TodoManage.tsx:895-899` 当前是：

```tsx
  const handleDashboardOpenTerminal = useCallback((_sessionId: string, todoId: string) => {
    setDashboardOpen(false)
    const todo = todos.find(x => x.id === todoId)
    if (todo) handleOpenTerminalInDock(todo, _sessionId)
  }, [todos, handleOpenTerminalInDock])
```

整块删除（5 行）。

- [ ] **Step A.8: 删 `handleDashboardStop` callback**

`web/src/TodoManage.tsx:901-908` 当前是：

```tsx
  const handleDashboardStop = useCallback(async (sessionId: string) => {
    try {
      await stopAiExec(sessionId)
      message.success('已发送停止')
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [])
```

整块删除（8 行）。

- [ ] **Step A.9: 删 `attentionItems` useMemo**

`web/src/TodoManage.tsx:909-913` 当前是：

```tsx
  const attentionItems = useMemo(() => buildAttentionItems({
    todos,
    liveSessions: [...liveSessionsMap.values()],
    seenSessionIds: seenReplySessionIds,
  }), [todos, liveSessionsMap, seenReplySessionIds])
```

整块删除（5 行）。注意紧邻的 `unreadItems` useMemo 保留。

- [ ] **Step A.10: 删 `persistSeenReplySessionIds` / `handleMarkAttentionSeen` / `handleClearReviewAttention`**

`web/src/TodoManage.tsx:910-922` 区域当前是（注意 Step A.9 删完 attentionItems 之后行号会前移）：

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

三个 callback 全部整块删除（共 13 行 + 中间空行）。

- [ ] **Step A.11: 简化 `handleOpenAttentionItem` 签名 + 删 `setDashboardOpen(false)`**

`web/src/TodoManage.tsx:968-981`（删除前的行号；执行时按内容定位）当前是：

```tsx
  const handleOpenAttentionItem = useCallback((item: AttentionItem | UnreadSessionItem) => {
    setDashboardOpen(false)
    setKeyword('')
    setFilterStatus('todo')
    const todo = todos.find(t => t.id === item.todoId)
    if (todo) handleOpenTerminalInDock(todo, item.sessionId)
    setHighlightTodoId(item.todoId)
    setPendingJumpTodoId(item.todoId)

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTodoId(null)
      highlightTimerRef.current = null
    }, 3000)
  }, [todos, handleOpenTerminalInDock])
```

改为：

```tsx
  const handleOpenAttentionItem = useCallback((item: UnreadSessionItem) => {
    setKeyword('')
    setFilterStatus('todo')
    const todo = todos.find(t => t.id === item.todoId)
    if (todo) handleOpenTerminalInDock(todo, item.sessionId)
    setHighlightTodoId(item.todoId)
    setPendingJumpTodoId(item.todoId)

    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTodoId(null)
      highlightTimerRef.current = null
    }, 3000)
  }, [todos, handleOpenTerminalInDock])
```

（删 `AttentionItem |` 联合类型 + 删 `setDashboardOpen(false)` 那一行）

- [ ] **Step A.12: 删 `<AttentionRail>` 调用点的 `onOpenDashboard` prop**

`web/src/TodoManage.tsx:1636-1640` 当前是：

```tsx
      <AttentionRail
        items={unreadItems}
        onActivate={handleOpenAttentionItem}
        onOpenDashboard={() => setDashboardOpen(true)}
      />
```

改为：

```tsx
      <AttentionRail
        items={unreadItems}
        onActivate={handleOpenAttentionItem}
      />
```

- [ ] **Step A.13: 删顶栏「AI 面板」按钮**

`web/src/TodoManage.tsx:1679-1684`（行号在 Step A.12 之后前移一两行；按内容定位）当前是：

```tsx
            <Button
              icon={<DashboardOutlined />}
              size="small"
              onClick={() => setDashboardOpen(true)}
              title="AI 工作面板"
            >AI 面板</Button>
```

整块删除（6 行）。上下保留「新建」「找回」「设置」等按钮。

- [ ] **Step A.14: 删 mobile 菜单「AI 面板」按钮**

`web/src/TodoManage.tsx:2419-2423` 当前是：

```tsx
          <Button
            icon={<DashboardOutlined />}
            onClick={() => { setMobileMenuOpen(false); setDashboardOpen(true) }}
            block
          >AI 面板</Button>
```

整块删除（5 行）。上下保留「找回历史会话」「Prompt 模板」等按钮。

- [ ] **Step A.15: 删 `<DashboardDrawer>` 渲染块**

`web/src/TodoManage.tsx:2471-2480` 当前是：

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

整块删除（10 行）。

- [ ] **Step A.16: 重写 `AttentionRail.tsx`**

`web/src/dock/AttentionRail.tsx` 全文当前内容已读过（63 行）。整体覆盖写入以下内容：

```tsx
import React from 'react'
import { Tooltip } from 'antd'
import type { UnreadSessionItem } from '../replyHub'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  items: UnreadSessionItem[]
  onActivate: (item: UnreadSessionItem) => void
}

export default function AttentionRail({ items, onActivate }: Props) {
  const isMobile = useIsMobile()
  if (isMobile) return null
  if (items.length === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  return (
    <div className="attention-rail is-alerting">
      <div className="attention-rail__items">
        {items.slice(0, 12).map(item => {
          const initial = (item.todoTitle || '?').charAt(0)
          return (
            <Tooltip key={item.id} title={item.todoTitle} placement="right">
              <button
                type="button"
                className="attention-rail__item kind-unread"
                onClick={() => onActivate(item)}
              >
                {initial}
              </button>
            </Tooltip>
          )
        })}
        {items.length > 12 && (
          <Tooltip title={`还有 ${items.length - 12} 条未读`} placement="right">
            <span className="attention-rail__more">+{items.length - 12}</span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
```

**改动要点**：
- `Props` 删 `onOpenDashboard`
- 删 `<button className="attention-rail__count">` 整块（红色数字球）
- 删 `displayCount` / `tooltipTitle` 局部变量
- 「+N 更多」从可点 `<button>` 改为不可点 `<span>`，tooltip 文案改为 "还有 N 条未读"

- [ ] **Step A.17: grep 收尾确认**

```bash
grep -n "dashboardOpen\|DashboardDrawer\|DashboardOutlined\|AI 面板\|onOpenDashboard\|attention-rail__count\|attentionItems\|buildAttentionItems\|AttentionItem\b\|SEEN_REPLY_STORAGE_KEY\|persistSeenReplySessionIds\|handleMarkAttentionSeen\|handleClearReviewAttention\|handleDashboardOpenTerminal\|handleDashboardStop\|parseSeenReplySessionIds\|serializeSeenReplySessionIds" web/src/TodoManage.tsx web/src/dock/AttentionRail.tsx
```

Expected: 无任何输出。若命中即漏删，回头补；不要进入下一步。

- [ ] **Step A.18: 跑构建**

```bash
cd web && npm run build
```

Expected: `tsc -b` 与 `vite build` 都成功。会出现 `dashboard/*` 目录下的文件被 tsc 检查（因为还在 `src/` 下被 include），但只要这些文件内部 import 的 `replyHub` 符号都还在（Task C 之前确实都还在），就能通过。如果出现 unused import / unused var (TS6133) 错误，回 Step A.1 ~ A.16 检查是否有漏删。

- [ ] **Step A.19: 提交**

```bash
git add web/src/TodoManage.tsx web/src/dock/AttentionRail.tsx
git commit -m "$(cat <<'EOF'
refactor(web): remove AI 工作面板 entry points

- TodoManage: 删 dashboardOpen state、useDrawerStack('dashboard')、
  attentionItems memo、seenReply 系列 callback、顶栏 + 移动菜单
  「AI 面板」按钮、<DashboardDrawer> 渲染、handleOpenAttentionItem
  收窄到只接受 UnreadSessionItem
- AttentionRail: 删数字球（attention-rail__count）和 onOpenDashboard prop，
  「+N」改为不可点的 span 计数

dashboard/ 目录本身仍在，下一个 commit 删。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B: 删除 `web/src/dashboard/` 整目录

**Files:**
- Delete: `web/src/dashboard/` 全目录（8 个文件）

- [ ] **Step B.1: 二次确认没有外部引用**

```bash
grep -rn "from .*dashboard/" web/src --include="*.tsx" --include="*.ts"
grep -rn "import.*dashboard/" web/src --include="*.tsx" --include="*.ts"
```

Expected: 无输出（Task A 已经清掉了唯一的 import）。若命中即停，回 Task A 补漏。

- [ ] **Step B.2: 删目录**

```bash
rm -rf web/src/dashboard
```

- [ ] **Step B.3: 跑构建**

```bash
cd web && npm run build
```

Expected: 通过。tsc 不再检查 dashboard/ 下的文件（因为已不存在）。

- [ ] **Step B.4: 提交**

```bash
git add -A web/src/dashboard
git commit -m "$(cat <<'EOF'
refactor(web): delete web/src/dashboard/ directory

DashboardDrawer / KpiStrip / AttentionHub / LiveSessionCard /
LiveGlanceTab / HistoryStatsTab / ResourceTab / dashboard.css。
所有消费点已在前一个 commit 摘除。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task C: 清 `replyHub.ts` / `api.ts` 中失去消费者的 export

**Files:**
- Modify: `web/src/replyHub.ts`
- Modify: `web/src/api.ts`

- [ ] **Step C.1: 删 `replyHub.ts` 顶部 dashboard 专用类型 + 常量**

`web/src/replyHub.ts:4-32` 当前是：

```ts
// rebrand: localStorage key kept for backward compatibility
export const SEEN_REPLY_STORAGE_KEY = 'quadtodo:seenAiReplies'

export type AttentionKind = 'interaction' | 'awaiting_reply' | 'review'

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
  awaitingReply: number
  review: number
}

export interface BuildAttentionItemsInput {
  todos: Todo[]
  liveSessions: SessionMeta[]
  seenSessionIds: Set<string>
}
```

整段删除（29 行，含开头那行注释 + 空行收尾）。`UnreadSessionItem` / `BuildUnreadSessionItemsInput` 接口保留。

- [ ] **Step C.2: 删 `buildAttentionItems` + `countAttentionItems` 函数**

`web/src/replyHub.ts:67-166` 当前是 `buildAttentionItems`（从 `export function buildAttentionItems(...)` 到第一个 `}`），紧接着 `countAttentionItems`（从 `export function countAttentionItems(...)` 到第二个 `}`）。两个函数加上它们之间的注释整体删除。

删除后，文件中应仅剩 `buildUnreadSessionItems` 这一个 `export function`。

- [ ] **Step C.3: 删 `parseSeenReplySessionIds` + `serializeSeenReplySessionIds`**

`web/src/replyHub.ts:225-239` 当前是：

```ts
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

整段删除（15 行）。

- [ ] **Step C.4: 验证 replyHub 内部 helper 仍被消费**

```bash
grep -n "normalizeTimestamp\|uniqueTodoSessions" web/src/replyHub.ts
```

Expected: 两个 helper 的 `function` 定义 + 各自在 `buildUnreadSessionItems` 内部的调用点都还在。它们是 `buildUnreadSessionItems` 的依赖，必须保留。

- [ ] **Step C.5: 删 `api.ts` 中的 `SessionStats` interface**

先用 Read 工具读 `web/src/api.ts:620-680` 区段确认 `SessionStats` interface 的准确边界（从 `export interface SessionStats {` 那行到匹配的 `}`），然后整段删除。后端 endpoint 名称（`/api/ai-terminal/stats`）保留不动。

- [ ] **Step C.6: 删 `api.ts` 中的 `getSessionStats` 函数**

`web/src/api.ts:652` 起的 `export async function getSessionStats(...)` 整个函数体（约 3 行）删除：

```ts
export async function getSessionStats(range: 'today' | 'week' | 'month'): Promise<{ range: string; since: number; until: number; stats: SessionStats }> {
  const body = await jsonFetch<{ ok: true; range: string; since: number; until: number; stats: SessionStats }>(`/api/ai-terminal/stats?range=${range}`)
  return body
}
```

（如果函数体超过 3 行，按实际代码块整体删，注意保留紧邻的 `getResourceSnapshot` 函数。）

- [ ] **Step C.7: 检查 `getResourceSnapshot` 是否还有消费者**

```bash
grep -rn "getResourceSnapshot\|ResourceSnapshot" web/src --include="*.tsx" --include="*.ts"
```

- 如果输出**仅**有 `api.ts` 自身的定义（`getResourceSnapshot` 函数 + `ResourceSnapshot` 类型）→ 一并删除该函数 + 类型 export
- 如果有其它消费者 → 保留不动，不在本任务清理

按 grep 结果实际处理；默认假设有 dashboard 之外的消费者，**保留**。

- [ ] **Step C.8: grep 收尾**

```bash
grep -rn "buildAttentionItems\|AttentionItem\b\|AttentionKind\|countAttentionItems\|AttentionCounts\|BuildAttentionItemsInput\|SEEN_REPLY_STORAGE_KEY\|parseSeenReplySessionIds\|serializeSeenReplySessionIds\|getSessionStats\|SessionStats" web/src --include="*.tsx" --include="*.ts"
```

Expected: 无任何输出。

- [ ] **Step C.9: 跑构建**

```bash
cd web && npm run build
```

Expected: 通过。

- [ ] **Step C.10: 提交**

```bash
git add web/src/replyHub.ts web/src/api.ts
git commit -m "$(cat <<'EOF'
refactor(web): drop dashboard-only exports from replyHub & api

replyHub: 删 AttentionKind / AttentionItem / AttentionCounts /
BuildAttentionItemsInput / buildAttentionItems / countAttentionItems /
SEEN_REPLY_STORAGE_KEY / parseSeenReplySessionIds /
serializeSeenReplySessionIds。
api: 删 SessionStats / getSessionStats。后端 /api/ai-terminal/stats
endpoint 保留待后续清理。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task D: 手动回归

- [ ] **Step D.1: 启 dev 服务**

```bash
cd web && npm run dev
```

打开 vite 给出的本地地址（通常 `http://127.0.0.1:5173`）。

- [ ] **Step D.2: 视觉与交互检查（4 项）**

1. **顶栏无「AI 面板」按钮**：桌面分辨率（>= md 断点）下，工具栏右侧仅有「新建」「找回」「设置」「更多」等按钮，**不应**出现「AI 面板」字样
2. **移动菜单无「AI 面板」**：缩小窗口到 < md，点「菜单」展开侧抽屉，里面**不应**有「AI 面板」按钮
3. **AttentionRail 无数字球**：左侧 rail 上方那个红色圆形数字（"1"/"2"/"99+"）应当不再出现；如有未读会话，只看到 todo 标题首字的头像按钮列表
4. **点头像跳 terminal 仍工作**：触发一个会留下未读的 AI 会话（比如 trigger 一次 claude/codex 调用让其有输出），等头像出现在 rail 上，点击 → 跳 TerminalDock 对应 tab 并高亮所属 todo

- [ ] **Step D.3: 验证 `useDrawerStack` 其它抽屉仍正常**

依次试一下「设置」「找回」「记忆」「报表」抽屉的开关 + 互斥行为（打开一个时 ESC 关闭它而不是关闭整个栈）。确认 Task A.6 中删 `'dashboard'` 的注册没有连带影响其它 drawer。

- [ ] **Step D.4: 收尾**

Task A / B / C 三个 commit 即构成完整变更。手动回归通过后回报"删除完成"。

如有 D.2/D.3 中发现的回归，单开一个 fix commit 修复，不要 amend 前面的 commit。

---

## 验收清单（与 spec 对齐）

- [ ] `web/src/dashboard/` 目录不存在（Task B）
- [ ] `TodoManage.tsx` 中无 `dashboardOpen` / `DashboardDrawer` / 「AI 面板」字样（Task A.17 grep 验证）
- [ ] mobile 菜单中无「AI 面板」选项（Task A.14）
- [ ] `AttentionRail` 不再有中央数字球按钮，只保留头像列表（Task A.16）
- [ ] `AttentionRail` 不接收 `onOpenDashboard` prop（Task A.16）
- [ ] `npm run build`（在 `web/` 目录）通过，无 unused import / unused var 警告（Task A.18 / B.3 / C.9）
- [ ] 手动回归：未读 session 出现 → AttentionRail 头像点击 → 跳 TerminalDock → 高亮对应 todo（Task D.2 第 4 项）
- [ ] 手动回归：四象限主页 + dock 行为无视觉/交互回归（Task D.2 第 1-3 项 + D.3）

## 不在本计划范围内（spec 已声明）

- 后端 endpoint 删除（`/api/ai-terminal/stats` 等）
- todo 卡片新增「待交互 / 待验收」徽章
- 重构 `replyHub.ts` 内部逻辑
- 改动 `TerminalDock` / 其它 drawer
