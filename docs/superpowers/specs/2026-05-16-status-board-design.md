# Status Board: Replace 4-Quadrant with Status-Driven 4-Column Layout

**Date**: 2026-05-16
**Status**: Approved (in brainstorming)
**Worktree**: `.claude/worktrees/status-board` (branch `worktree-status-board`)

## Problem

The 2×2 Eisenhower quadrant view is no longer the user's mental model. In practice users reason about work by AI-session state ("what's running, what's blocked on me, what's idle") rather than by importance × urgency. The current UI also accumulated rarely-used features (subtodos, stage tags, in-todo Fork) that compete for screen real estate without delivering proportional value.

Additionally, the existing data model lets a todo accumulate multiple AI sessions over time — possibly even concurrently (dev-agent + test-agent on the same todo). The previous UI buried that history inside a per-card session dropdown nobody used.

## Goal

Replace the 2×2 quadrant board with a 4-column status board that surfaces a **clear separation between todos and the AI sessions that work on them**:

- The **Backlog** column lists todos. A todo only leaves Backlog when the user explicitly marks it Done.
- The **In Progress / Needs Input / Idle** columns list active *sessions* (which point back to their parent todo).
- A todo may produce zero, one, or many sessions over its lifetime; sessions may run concurrently.
- Terminal sessions (done / failed / stopped) leave the board and are accessible via the todo's History affordance, where they can be re-opened or natively resumed.

Rename the Templates feature to "Agents" in the UI (code identifiers stay), add an Agent sidebar that shows each agent's current workload, replace the modal "Start" with an inline agent-picker popover, and trim obsolete concepts (subtodos, stage tags, priority tags, quadrant pickers in IM bots). Keep the change reversible: no DB migration.

## Non-Goals

- DB schema migration. The `todos.quadrant` column stays; new todos default `quadrant = 1`.
- LLM-based auto-delegation. The Start popover is manual.
- Live tool activity chips on cards (Read / WebSearch / subagent_stop). Out of scope.
- Per-card AI tool override. Tool is a global setting.
- Focus Mode UI redesign. `SessionFocus` is reused as-is.
- Backwards-compat ergonomics for callers that still pass `quadrant`. We accept and ignore, no new affordances.

## Architecture

### Two kinds of cards

The board renders **two different card types** in different columns:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Backlog              │  In Progress  │  Needs Input  │  Idle         │
│ ────────────────────────────────────────────────────────────────────  │
│ ◇ TodoCard           │ ◆ SessionCard │ ◆ SessionCard │ ◆ SessionCard │
│   Title              │   ↩ Parent    │   ↩ Parent    │   ↩ Parent    │
│   Description        │   Agent chip  │   Agent chip  │   Agent chip  │
│   👤 agent · ↻ 2/5   │   Tool · time │   Tool · time │   Tool · time │
│   [▶ Start new]      │   [Cancel]    │   [Confirm]   │   [Re-open]   │
│   [✓ Done]           │               │   [Cancel]    │   [× Close]   │
└──────────────────────────────────────────────────────────────────────┘
```

- **TodoCard** lives only in Backlog. Title / description / current-agent chip / history counter / `Start new` / `Done`.
- **SessionCard** lives in the right 3 columns. References parent todo by title (clickable, scrolls/highlights the parent). Shows agent + tool + status + elapsed + tokens. Column-specific buttons.

### Column derivation

| Column | Renders | Predicate |
|---|---|---|
| Backlog | TodoCards | `todo.status NOT IN ('done', 'missed')` |
| In Progress | SessionCards | `session.status === 'running'` |
| Needs Input | SessionCards | `session.status === 'pending_confirm'` |
| Idle (已空闲) | SessionCards | `session.status === 'idle'` |

Sessions in terminal states (`done` / `stopped` / `failed`) leave the board entirely and live in the parent todo's History. Todos with `status === 'done'` are filtered out by default; a "show completed" toggle reveals them in Backlog.

### Concurrency model

A todo may have multiple sessions simultaneously running, pending, idle, or in any combination. There is **no per-todo session cap**. PtyManager already isolates by `session_id`, so concurrent PTYs need no backend changes.

### Aesthetic

Industrial control deck × editorial dark theme:
- **Background**: deep neutral (`#08090b`) with very subtle radial gradients of accent.
- **Accent**: electric lime `#d4ff3a` (active). Amber `#ff8a3d` for needs-input. Jade `#6ce5b6` for idle. Slate `#5a6171` for backlog.
- **Typography**: `Instrument Serif` italic for large display numbers (column counts, agent load), `JetBrains Mono` for labels/timestamps/tool tags, `DM Sans` for body.
- **Edges**: 0–2px radius. Sharp by default.
- **Motion**: stagger-in on mount; pulse-dot for running sessions; blink arrow on urgent cards.
- **Atmosphere**: subtle SVG grain overlay at 50% opacity, mix-blend overlay.

A reference HTML mockup lives at `/tmp/agentquad-status-board-mockup.html` during development. Not committed.

### Frontend component map

| New / Changed | Path | Purpose |
|---|---|---|
| New | `web/src/components/StatusBoard/StatusBoard.tsx` | 4-column flex board; resizable column dividers |
| New | `web/src/components/StatusBoard/BacklogColumn.tsx` | Backlog-specific column (renders TodoCards) |
| New | `web/src/components/StatusBoard/SessionColumn.tsx` | Generic session column (renders SessionCards) |
| New | `web/src/components/StatusBoard/statusConfig.ts` | Maps column id → `{ labelKey, accent, dotColor, predicate }` |
| New | `web/src/components/SessionCard/SessionCard.tsx` | Right-column card; references parent todo |
| New | `web/src/components/AgentSidebar/AgentSidebar.tsx` | Left sidebar of agents |
| New | `web/src/components/AgentSidebar/AgentCard.tsx` | One agent row: avatar, name, load (active session count), in-flight session list |
| New | `web/src/components/TopbarTools/TopbarTools.tsx` | 6-icon toolbar (+ / Agents / Transcripts / Stats / Settings / Theme) |
| New | `web/src/components/StartAgentPopover/StartAgentPopover.tsx` | Inline popover anchored to Start button |
| New | `web/src/components/TodoHistoryMenu/TodoHistoryMenu.tsx` | Dropdown on TodoCard listing all of that todo's sessions (any state); per-row Resume / Open-Focus action |
| Deleted | `web/src/components/QuadrantBoard/*` | Replaced |
| Changed | `web/src/TodoManage.tsx` | Swap board + sidebar; remove quadrant logic; drop child-todo grouping; drop stage chip rendering. Build a flat list of sessions across todos for the right columns. |
| Changed | `web/src/components/TodoCard/TodoCard.tsx` | Remove: stage chip, create-subtodo button, in-card session dropdown, priority tag. Add: agent chip with current default, `↻ N/M` history chip, `Start new` button, `Done` button. |
| Changed | `web/src/api.ts` | Keep `Todo.aiSessions: AiSession[]`. Add `Todo.activeSessionCount` (or compute client-side). |
| Changed | `web/src/SettingsDrawer.tsx` | Add "Default AI Tool" picker (single-tool case shows status text only). |
| Changed | `web/src/TemplateDrawer.tsx` | Title/copy rebrand "Templates" → "Agents / 员工档案". |
| Changed | `web/src/i18n/locales/{zh-CN,en-US}.ts` | New keys `board.column.*`, `agent.*`, `session.*`. Legacy `quadrant.*` and `stage.*` kept for transcript history fidelity. |

### Backend changes

| File | Change |
|---|---|
| `src/routes/ai-terminal.js` | Read `config.defaultTool` when `tool` not specified in start request. **No 1:1 enforcement**: multiple sessions per todo are allowed. |
| `src/routes/todos.js` | Add `POST /api/todos/:id/done` (or extend existing patch) that marks `todo.status = 'done'` and optionally accepts `force: true` to terminate any still-active sessions on that todo. |
| `src/config.js` | New optional field `defaultTool: 'claude' \| 'codex' \| 'cursor'`. `getDefaultTool()` helper resolves: explicit config → only-installed-tool → null. |
| `src/openclaw-wizard.js` | Drop `STEP_QUADRANT`, `parseQuadrant`, the quadrant-stripping regex. `STEP_TEMPLATE` keeps its key but user-visible copy says "Agent / 员工". |
| `src/mcp/tools/openclaw/index.js` | `list_quadrants` returns `{ quadrants: [], deprecated: true }`. `list_templates` description rewritten ("agent / 员工"). |
| `src/mcp/tools/{read,write,destructive}/index.js` | `quadrant` arg kept on input schemas for compat. Insert path ignores it (DB defaults to 1). Descriptions reword to mention "legacy field; ignored." |
| `src/prompt-render.js` | Drop `quadrant` from `vars` passed to prompt templates. |
| `src/export/todoMarkdown.js` | Remove the `**象限**：…` line and quadrant filter on subtodo lookup. |
| `src/wiki/sources.js`, `src/wiki/index.js` | Stop emitting `quadrant:` lines in wiki extracts. |
| `src/stats/report.js` | Drop `quadrant` from usage rollup keys. |
| `src/cli.js` | Update top-level `description` from "four-quadrant todo CLI" to "status-driven todo CLI with embedded …". |

DB schema is untouched.

### Data flow

**Start an AI session on a todo (first or Nth time)**
1. User clicks `Start new` on a TodoCard.
2. `StartAgentPopover` opens anchored to the card. List = `templates` from store + `No agent` pseudo-item. Default selection = last-used agent for this todo (or globally last-used on first run).
3. User picks → clicks Go.
4. Frontend calls `POST /api/ai-terminal/start { todoId, templateIds: [picked] | [] }`. Tool is **not** sent; backend reads `config.defaultTool`.
5. Backend creates a fresh session and PTY. Existing sessions on the same todo are left alone.
6. WS streams the new PTY output. A new SessionCard appears in In Progress.
7. The TodoCard's `↻ N/M` chip increments.

**A running session asks for permission**
1. PtyManager / prompt detector flips `session.status = 'pending_confirm'`.
2. SessionCard moves from In Progress to Needs Input.
3. The card's left edge gets the amber accent and the blinking `→`.
4. User clicks `Confirm` (or replies in Focus Mode) → backend dispatches the keypress → status returns to `running`.

**A session finishes "naturally"**
1. Tool reports the turn is done. `session.status = 'idle'`. PTY stays alive (user can ask a follow-up).
2. SessionCard moves to **Idle (已空闲)**.

**User closes an idle session**
1. User clicks `Close` on the Idle card.
2. Backend terminates the PTY, sets `session.status = 'done'`.
3. SessionCard disappears from the board.
4. Record is preserved in `ai_session_log`; accessible via TodoCard's History.

**User recovers a historical session**
1. On a TodoCard, click `↻ N/M`. `TodoHistoryMenu` opens listing all sessions for this todo (any state, newest first).
2. For terminal sessions (done/stopped/failed), the row has a `Resume` button: calls the existing `onOpenNativeResume` path (`claude --resume <id>` / `codex resume <id>`). A new session is created seeded from the old; it lands in In Progress.
3. For non-terminal sessions, the row has `Open in Focus` (just navigates to Focus Mode).

**User marks todo Done**
1. User clicks `Done` on a TodoCard.
2. If active sessions exist: confirm dialog — "还有 N 个会话在运行/空闲，强制关闭并完成吗？" with `Force` / `Cancel`.
3. `POST /api/todos/:id/done { force: true }`: backend iterates active sessions, terminates PTYs, then sets `todo.status = 'done'`.
4. TodoCard disappears from Backlog. All its remaining session cards (if any) disappear too.

**Reassign default agent on a todo**
- TodoCard's agent chip is a dropdown that overwrites `applied_template_ids` on the todo. Next `Start new` uses this as the popover's default selection.

### Mobile layout

- Topbar collapses to brand + hamburger (existing pattern).
- Agent sidebar becomes a horizontal scroll strip directly under the topbar. Each agent renders as a chip (avatar + name + load badge). Tapping selects, double-tap opens edit.
- Status board becomes a 4-tab swipe deck. Tab labels: 待办 / 运行中 / 需确认 / 已空闲. Counts on each tab.
- Cards keep the desktop layout. Buttons grow to comfortable tap targets.

### Drag & drop

- In-column reorder for **Backlog** preserved via existing `@dnd-kit/sortable` setup, using `todo.sort_order`.
- Right 3 columns: no drag (sessions are ordered by `startedAt` desc).
- Cross-column drag: disabled. First attempt shows a small tooltip "状态由 AI 推导，无法手动拖动" (persisted via `localStorage` `dndHintShown`).

### Error & edge cases

| Case | Behavior |
|---|---|
| Existing todo with multiple historical sessions | All surface in `↻ N/M` history; the right columns flatten them by current status. |
| `config.defaultTool` unset and only one tool installed | Resolve to that tool implicitly. |
| `config.defaultTool` unset and multiple installed | First-run wizard handles initial setup. After, Settings shows selector with no default; Start button shows toast "请到设置选择默认 AI 工具" until picked. |
| `config.defaultTool` set to a tool that's no longer present | Start button shows error toast + jump-to-settings button. |
| MCP `start_ai_session` with explicit `tool` arg | Honored; bypasses `defaultTool`. |
| Subtodo from old data (`parent_id != null`) | Flattened: rendered as its own top-level TodoCard in Backlog. Visual link to parent is dropped. |
| Stage chip data | Field preserved in DB; UI doesn't render. |
| `quadrant` arg on MCP create/list | Accepted, ignored on create. Returned in read responses unchanged. |
| Lark/Telegram wizard with users that memorized "象限 N" | Old syntax no longer parsed; `buildTemplateMessage` adds a soft note that 象限 was removed. |
| Idle session whose PTY died externally (e.g. OS reaped) | Backend watcher already flips status to `failed`; card leaves Idle automatically. |
| Todo with 10+ concurrent sessions | UI doesn't cap; columns scroll. (Practical concern only.) |

### Testing

| Scope | Strategy |
|---|---|
| Unit | Status-→-column derivation (pure fn). Session predicates. AgentSidebar load computation. TodoHistoryMenu sort/grouping. |
| Integration | `routes/todos.js` `done` endpoint with `force` flag terminates active sessions. `routes/ai-terminal.js` allows multiple sessions on the same todo. Settings router `defaultTool` round-trip. |
| Manual | `npm start`, walk through: create todo → Start (dev-agent) → start another (test-agent) on same todo → both show in In Progress → one pauses for permission → confirm → other finishes → goes Idle → close it → recover from history → mark Done with force. Verify agent sidebar load counts update live. Verify mobile via Chrome DevTools 375px. |
| Migration check | Open with an existing `~/.agentquad/data.db` containing multi-session and subtodo data. Verify no crash; subtodos flatten; multi-sessions surface correctly. |
| Regression | Pre-existing vitest failures (pty.test.js flake on this machine) must not increase. `npm run build` must succeed. Note: project's `vitest.config.js` uses `pool: 'vmThreads'` which SIGSEGVs on this machine; dev runs `vitest run --pool=forks`. |

### Rollout

- Single PR / single merge to `main`. AgentQuad auto-pushes; release script bumps version after merge.
- No DB migration, no config migration, no breaking API change. Old MCP / IM-bot callers continue to function — they just see fewer steps.

## Decisions Locked In

1. UI rename Templates → Agents; **code identifiers stay `template`**.
2. todo ↔ session is **1 : N**, with **concurrent sessions permitted**.
3. Start popover is **manual** (user picks agent each time). LLM auto-delegation deferred.
4. Tool selection lives in **Settings as `defaultTool`**, not on the Start popover.
5. Quadrant column stays in DB. New todos default `quadrant = 1`. Never shown in UI.
6. Subtodos: UI removed; data preserved; existing subtodos flatten to top-level TodoCards.
7. Stage tags: UI removed; data preserved.
8. Backlog cards are **TodoCards**; right 3 columns are **SessionCards** — distinct components.
9. A todo leaves Backlog only via **manual `Done`**; never auto-promoted by session activity.
10. Idle sessions are **manually closed** by the user; auto-close not implemented.
11. Terminal sessions (`done` / `stopped` / `failed`) are **off the board**; accessible via TodoCard's `↻ History`. Resumable via existing native-resume flow.
12. Cross-column drag: disabled. In-column reorder kept for Backlog only.
13. IM bots (Lark/Telegram via openclaw-wizard): quadrant step removed; template step relabeled "Agent".
14. Fourth column renamed from "已完成" to **"已空闲" (Idle)** to better reflect that the PTY is still alive.

## Open Questions

None.
