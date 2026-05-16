# Status Board: Replace 4-Quadrant with Status-Driven 4-Column Layout

**Date**: 2026-05-16
**Status**: Approved (in brainstorming)
**Worktree**: `.claude/worktrees/status-board` (branch `worktree-status-board`)

## Problem

The 2×2 Eisenhower quadrant view is no longer the user's mental model. In practice each todo is paired with one AI agent session, and the user reasons about todos by *session state*, not by *importance × urgency*. The current UI also accumulated several rarely-used features (subtodos, stage tags, multi-session per todo, in-todo Fork) that compete for screen real estate without delivering proportional value.

## Goal

Replace the 2×2 quadrant board with a 4-column status board derived from `todo.status`, enforce a 1:1 todo↔AI-session relationship, surface an Agent (renamed from Template) sidebar, and trim the obsolete concepts. Keep the change reversible by leaving the underlying DB schema intact.

## Non-Goals

- DB schema migration. The `todos.quadrant` column stays. New todos default `quadrant = 1`.
- Auto-delegation (LLM picks an agent). The Start popover is manual ("半自动") — agent dropdown + Go. Smart delegation is a separate future spec.
- Live tool activity chips on cards (Read / WebSearch / subagent_stop). Not in scope.
- Per-card AI tool override. Tool is a global setting; users who switch tools change settings, not the card.
- Focus Mode page. Untouched — `SessionFocus` is reused as-is.
- Backwards-compat shims. MCP/HTTP callers that pass `quadrant` are tolerated (we accept and ignore), but no new ergonomics are added for them.

## Architecture

### Layout

```
┌────────────────────────────────────────────────────────────────────┐
│ Topbar:  brand · │ + 📇 🔍 📊 ⚙ ☼ │ · AGENTS 5 / ACTIVE 4 / PEND 1 │
├──────────────┬─────────────────────────────────────────────────────┤
│              │  待办      │  运行中    │  需确认    │  已完成      │
│ Agent        │  status=   │  status=   │  status=   │  status=     │
│ Sidebar      │  todo      │  ai_running│  ai_pending│  ai_done     │
│ (员工档案)    │            │            │            │              │
│   阿码 [2]   │  ┌──────┐  │  ┌──────┐  │  ┌──────┐  │  ┌──────┐    │
│   审稿机 [1] │  │ card │  │  │ card │  │  │ card │  │  │ card │    │
│   花活总监 0 │  └──────┘  │  └──────┘  │  └──────┘  │  └──────┘    │
│   笔杆子   0 │            │            │            │              │
│   情报员 [1] │            │            │            │              │
│   ∅ No agent │            │            │            │              │
│              │            │            │            │              │
│ + 招新员工    │            │            │            │              │
└──────────────┴─────────────────────────────────────────────────────┘
```

Status column derivation:

| Column | Predicate |
|---|---|
| 待办 (backlog) | `todo.status === 'todo'` |
| 运行中 (in_progress) | `todo.status === 'ai_running'` |
| 需确认 (needs_input) | `todo.status === 'ai_pending'` |
| 已完成 (complete) | `todo.status === 'ai_done'` |

`status ∈ { 'done', 'missed' }` is filtered out by the existing "show done" toggle and not assigned a column.

### Aesthetic

Industrial control deck × editorial dark theme:
- **Background**: deep neutral (`#08090b`) with very subtle radial gradients of accent
- **Accent**: electric lime `#d4ff3a` (active/running). Amber `#ff8a3d` for needs-input, jade `#6ce5b6` for complete, slate `#5a6171` for backlog
- **Typography**: `Instrument Serif` italic for large display numbers (column counts, agent load), `JetBrains Mono` for labels/timestamps/tool tags, `DM Sans` for body
- **Edges**: 0–2px corner radius. Sharp by default.
- **Motion**: stagger-in on mount; pulse-dot for running sessions; blink arrow on urgent cards
- **Atmosphere**: subtle SVG grain overlay, mix-blend overlay at 50% opacity

A reference HTML mockup lives at `/tmp/agentquad-status-board-mockup.html` during development. It is not committed to the repo.

### Frontend component map

| New / Changed | Path | Purpose |
|---|---|---|
| New | `web/src/components/StatusBoard/StatusBoard.tsx` | 4-column flex board; resizable column dividers |
| New | `web/src/components/StatusBoard/StatusColumn.tsx` | Single column rendering + DnD droppable for in-column reorder |
| New | `web/src/components/StatusBoard/statusConfig.ts` | Maps `TodoStatus → { labelKey, accent, dotColor }` |
| New | `web/src/components/AgentSidebar/AgentSidebar.tsx` | Left sidebar of agents (i.e. templates) |
| New | `web/src/components/AgentSidebar/AgentCard.tsx` | One agent row: avatar, name, load, in-flight todo list |
| New | `web/src/components/TopbarTools/TopbarTools.tsx` | 6-icon toolbar (+ / Agents / Transcripts / Stats / Settings / Theme) |
| New | `web/src/components/StartAgentPopover/StartAgentPopover.tsx` | Inline popover anchored to Start button |
| New | `web/src/components/TodoCard/CardSessionRow.tsx` | Tool · time · status · elapsed · tokens · 本地/远程 detail row |
| Deleted | `web/src/components/QuadrantBoard/*` | Replaced |
| Changed | `web/src/TodoManage.tsx` | Swap board + sidebar, remove quadrant logic, drop child-todo grouping, drop stage chip rendering |
| Changed | `web/src/components/TodoCard/TodoCard.tsx` | Remove: stage chip, create-subtodo button, session-list dropdown, priority tag, Fork-as-new-session. Add: agent chip, session detail row, per-column action buttons |
| Changed | `web/src/api.ts` | `Todo.aiSessions: AiSession[]` removed; only `aiSession: AiSession \| null` remains. `Todo` keeps `quadrant` field (still required by backend) but it's never displayed |
| Changed | `web/src/SettingsDrawer.tsx` | Add "Default AI Tool" picker (single-tool case shows status text only) |
| Changed | `web/src/TemplateDrawer.tsx` | Title/copy rebrand "Templates" → "Agents / 员工档案" |
| Changed | `web/src/i18n/locales/{zh-CN,en-US}.ts` | New keys `board.column.*`, `agent.*`, `session.*`. Legacy `quadrant.*` and `stage.*` kept for transcript history fidelity |

### Backend changes

| File | Change |
|---|---|
| `src/routes/ai-terminal.js` | On start: reject when `todo.ai_session` exists and is active (`running`/`pending_confirm`/`idle`). Error code `todo_already_has_active_session` (HTTP 409). Read `config.defaultTool` when `tool` not specified in request. |
| `src/config.js` | New optional field `defaultTool: 'claude' \| 'codex' \| 'cursor'`. Honored by `getDefaultTool()` helper. |
| `src/openclaw-wizard.js` | Drop `STEP_QUADRANT`, `parseQuadrant`, the quadrant-stripping regex on free text. `STEP_TEMPLATE` keeps its key but user-visible copy says "Agent / 员工". `buildTemplateMessage` text rewritten. |
| `src/mcp/tools/openclaw/index.js` | `list_quadrants` returns `{ quadrants: [], deprecated: true }`. `list_templates` description rewritten ("agent / 员工"). |
| `src/mcp/tools/{read,write,destructive}/index.js` | `quadrant` arg kept on input schema for compat (write/patch ignore it on insert path — `db.createTodo` already defaults to `1`); descriptions reword to mention "legacy field; ignored." |
| `src/prompt-render.js` | Drop `quadrant` from `vars` object passed to prompt templates. |
| `src/export/todoMarkdown.js` | Remove the `**象限**：…` line and quadrant filter on subtodo lookup. |
| `src/wiki/sources.js`, `src/wiki/index.js` | Stop emitting `quadrant:` lines in wiki extracts. |
| `src/stats/report.js` | `quadrant` no longer included in usage roll-up keys. |
| `src/cli.js` | Update top-level `description` from "four-quadrant todo CLI" to "status-driven todo CLI with embedded …". |

DB schema is untouched. `todos.quadrant`, `ai_session_log.quadrant`, indexes `idx_todos_quadrant_sort` / `idx_todos_quad_parent_sort` / `idx_ail_quadrant` remain.

### Data flow

**Start an AI session**
1. User clicks Start on a Backlog card.
2. `StartAgentPopover` opens, anchored to the card. List = `templates` from store + "No agent" pseudo-item. Default selection = last-used `template_id` (or "No agent" on first run).
3. User picks → clicks Go.
4. Frontend calls `POST /api/ai-terminal/start { todoId, templateIds: [picked] | [] }`. Tool is **not** sent; backend uses `config.defaultTool`.
5. Backend validates `todo.ai_session` is null or in terminal state. If active → 409 `todo_already_has_active_session`.
6. Session created; WS streams PTY output; `todo.status` transitions `todo → ai_running`.

**Reassign agent on a Backlog card**
- Same Start flow. Picking a different agent overwrites `applied_template_ids` on the todo via the existing patch endpoint.

**Restart after AI finishes**
- AI idle → `todo.status = ai_done`. Card lives in Complete column with a small "Restart" affordance behind a kebab (out of scope detail, default to Focus Mode's existing restart).

**Cancel / Done**
- `Cancel`: stops the PTY (existing endpoint), session moves to `stopped` state, todo returns to Backlog (`status = 'todo'`).
- `Done`: marks `todo.status = 'done'`, hides from default view.

### Mobile layout

- Topbar collapses to brand + hamburger (existing pattern).
- Agent sidebar becomes a horizontal scroll strip directly under the topbar. Each agent renders as a chip (avatar + name + load badge). Tapping selects, double-tap opens edit.
- Status board becomes a 4-tab swipe deck (existing approach for filter pills). Tab labels: 待办 / 运行中 / 需确认 / 已完成. Counts on each tab.
- Cards keep the desktop layout. Buttons grow to comfortable tap targets.

### Drag & drop

- In-column reorder: preserved via existing `@dnd-kit/sortable` setup, using `todo.sort_order`.
- Cross-column drag: **disabled**. Drop zones outside the source column reject. We surface a small tooltip "状态由 AI 推导，无法手动拖动" the first time the user tries it (persisted via `localStorage` `dndHintShown`).

### Error & edge cases

| Case | Behavior |
|---|---|
| Existing todo with `aiSessions.length > 1` | Frontend reads only `todo.aiSession`. Older sessions remain in `~/.agentquad/logs/` and `ai_session_log`. Transcript drawer still finds them by session id. |
| `config.defaultTool` unset and only one tool installed | Resolve to the installed tool implicitly. |
| `config.defaultTool` unset and multiple installed | First-run wizard already handles. After the wizard, settings show selector with no default; Start button is disabled until user picks. Toast: "请到设置选择默认 AI 工具". |
| `config.defaultTool` set to a tool that's no longer present | Start button shows error toast + jump-to-settings button. |
| MCP `start_ai_session` with explicit `tool` arg | Honored; bypasses `defaultTool`. |
| Subtodo from old data (`parent_id != null`) | Flattened: rendered as its own top-level card in the column dictated by its own `status`. Visual identity to parent is dropped. |
| Stage chip data | Field preserved in DB; UI doesn't render. |
| `quadrant` arg on MCP create/list | Accepted, ignored on create (DB defaults). Returned in read responses unchanged. |
| Lark/Telegram wizard mid-flow when bot user is on old version | The `STEP_QUADRANT` step disappears; users that had memorized "象限 N" syntax get a soft hint in `buildTemplateMessage` that象限 has been removed. |

### Testing

| Scope | Strategy |
|---|---|
| Unit | New status→column derivation (pure fn) gets a vitest unit test. AgentSidebar selectors (count, load) get unit tests. |
| Integration | `routes/ai-terminal.js` 1:1 guard test (409 path). Settings router `defaultTool` round-trip. |
| Manual | Run `npm start`, walk through: create todo → Start → run AI → see card move column → permission prompt → Done → Complete column. Verify agent sidebar load count updates. Verify mobile via Chrome DevTools 375px. |
| Migration check | Open with an existing `~/.agentquad/data.db` containing multi-session and subtodo data. Verify no crash; flattened display; sessions still openable via Focus mode. |
| Regression | Existing vitest suite must stay green. `npm run build` (Vite + tsc -b) must succeed. |

### Rollout

- Single PR / single merge to `main`. AgentQuad already auto-pushes on commit; release script bumps version after merge.
- No DB migration, no config migration, no breaking API change. Old MCP and IM bot callers continue to function — they just see fewer steps.

## Decisions Locked In

Captured here so they don't have to be re-debated mid-implementation.

1. UI rename Templates → Agents; **code identifiers stay `template`** (zero refactor).
2. todo ↔ session is **1:1**. Old multi-session data is hidden behind `aiSession` only.
3. Start popover is **manual** (α option). LLM auto-delegation deferred.
4. Tool selection lives in **Settings as `defaultTool`**, not on the Start popover.
5. Quadrant column stays in DB. New todos default `quadrant = 1`. Never shown in UI.
6. Subtodos: UI removed; data preserved; existing subtodos flatten.
7. Stage tags: UI removed; data preserved.
8. Fork: kept as "create new todo with seeded context"; no longer creates a second session on the same todo.
9. Cross-column drag: disabled.
10. IM bots (Lark/Telegram via openclaw-wizard): quadrant step removed; template step relabeled "Agent".

## Open Questions

None. Design is implementation-ready.
