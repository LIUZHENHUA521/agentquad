# UI Overhaul — M3 + M4 Combined Implementation Plan (Overnight Run)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Land all remaining UI overhaul work — Hero TodoCard + sparkline + AI status visuals (M3 visible polish), QuadrantBoard extract + TodoManage split + dock cleanup (M3 maintainability), drawer consolidation + toolbar consolidation + TSX hex migration + mobile pass (M4 polish + cleanup) — in one continuous overnight run.

**Strategy:** Combined run, but with two milestone tags (`ui-overhaul-m3` + `ui-overhaul-m4`) so the user can revert at either gate. Conservative visual decisions following the validated mockup; no UX invention; no backend changes; no real-device mobile QA.

**User-confirmed decisions (pre-run):**
- Hero TodoCard: strict mockup match, no creative deviation
- Delete `web/src/dock/` directory entirely (no fallback)
- 找回 button → relocate to TopbarDispatch right side (next to Settings/ThemeToggle)
- Telegram sync + Template buttons → removed from toolbar, accessible only via ⌘K (already wired in M2)
- Stats + Report drawer → merge into single drawer with AntD Tabs

**Spec reference:** `docs/superpowers/specs/2026-05-12-ui-overhaul-ai-first-design.md` § M3, M4
**Visual reference:** `mockups/ui-overhaul-preview.html`
**Builds on:** M1 (`ui-overhaul-m1`) + M2 (`ui-overhaul-m2`) + M2.5 (`ui-overhaul-m2.5`)

---

## Process notes

- **One commit per task**, prefixed `feat(card):`, `refactor(state):`, `chore(cleanup):`, `feat(drawer):`, `feat(topbar):` etc.
- **Combined spec+quality review** for trivial/mechanical tasks (saves dispatches); full 3-stage review for Hero TodoCard (M3-T6) + TodoManage split (M3-T10).
- **No new backend code.** Real "Log 日志" tab and any feature requiring server changes are explicitly OUT OF SCOPE.
- **Skip:** mobile real-device QA, performance baseline measurement (require human + browser).
- **Stop and report** if BLOCKED. Don't ignore subagent escalations.

---

## M3: Hero card + cleanup (~11 tasks)

### M3-T1: Delete `web/src/dock/` directory + remove dock import in TodoManage

**Files:**
- Delete: `web/src/dock/TerminalDock.tsx`, `TerminalDockTab.tsx`, `dock.css`, `popout.css`, plus `web/src/store/terminalDockStore.ts`
- Modify: `web/src/TodoManage.tsx` — remove `import { useTerminalDockStore }` (line ~61) — already orphan after M2.5 dock removal

Build PASS, commit: `chore(cleanup): delete dock directory + terminalDockStore`

### M3-T2: Remove all dock-orphan code in TodoManage

After T1, TodoManage will have ~30 lines of dead references (`dockOpenTabs`, `dockActiveTabId`, `resolveTabContext`, `handleDockSession*`, `focusSessionInDock`, `onOpenSessionInDock`). Remove them.

If `onOpenSessionInDock` was a prop on `SortableTodoCard`, remove from interface + all callsites.

Build PASS, commit: `chore(cleanup): remove dock orphan code from TodoManage`

### M3-T3: SessionFocus magic 52px → `var(--topbar-dispatch-h)`

Modify: `web/src/components/SessionFocus/SessionFocus.css` — change `inset: 52px 0 0 0` to `inset: var(--topbar-dispatch-h, 52px) 0 0 0`.

Commit: `chore(token): use --topbar-dispatch-h in SessionFocus inset`

### M3-T4: ⇆ button uses SwapOutlined icon

Modify: `web/src/TodoManage.tsx` SortableTodoCard's ⇆ button — change content from text `⇆` to `<SwapOutlined />` (import from `@ant-design/icons`).

Commit: `feat(card): replace ⇆ glyph with SwapOutlined icon`

### M3-T5: Build ActivitySparkline component

**Files:** Create `web/src/components/ActivitySparkline/{tsx,css,index.ts}`

Component:
- Props: `sessionId: string`, `width?: number = 88`, `height?: number = 18`
- Subscribes to `useAiSessionStore.outputRates.get(sessionId)` (existing real-time output bytes/sec)
- Maintains a rolling buffer of last 12 samples (1 sample per render frame, throttled to 1Hz)
- Renders SVG polyline with `stroke="var(--accent-electric)"`
- When idle (no rate data), renders flat low line at 0.4 opacity

Commit: `feat(card): add ActivitySparkline SVG component`

### M3-T6: Hero TodoCard rebuild ⭐ (full 3-stage review)

**Files:** 
- Create `web/src/components/TodoCard/{TodoCard.tsx,TodoCard.css,index.ts}`
- Modify `web/src/TodoManage.tsx` SortableTodoCard to render `<TodoCard todo={todo} ...>` instead of inline JSX

Layout matches mockup:
```
┌─────────────────────────────┐
│ Q1 ●  优化首屏性能          │
│ ────────────────────────── │
│ [claude] running ▶ 12m      │  (mono)
│ ▁▃▅▇▅▃▁▁ 2.4k tok           │  (sparkline + tokens)
│ #perf #frontend  ⌘ to focus │
└─────────────────────────────┘
```

- Quadrant border-left 2px in q-color
- AI status row only when `todo.aiSession` exists
- Sparkline only when session is running
- hover: action buttons (fork / SwapOutlined / archive) appear top-right
- card click → `dispatchStore.openFocus(todo.id, sessionId)` if active session, else default edit
- Preserves: dnd-kit attrs/listeners, data-todo-id attribute (M2-T11), checkbox, sub-todos
- AI status colors: running → green pulse; pending_confirm → amber pulse; idle → gray; done → no indicator

Conservative on edge cases:
- Long titles: ellipsis with title attribute
- Multiple sessions per todo: show most recent active in card row
- Sub-todos: keep existing rendering inside TodoCard (don't restructure)

Commit: `feat(card): rebuild TodoCard with hero layout + sparkline`

### M3-T7: AI status pulse / glow animations

**Files:** `web/src/components/TodoCard/TodoCard.css`

Add keyframes:
- `@keyframes ai-running-pulse` — green dot scales 1 → 1.3 with opacity, 1.6s loop
- `@keyframes ai-thinking-glow` — electric color text-shadow flicker, 1.6s
- `@keyframes ai-pending-pulse` — amber dot, faster 1.2s

Commit: `feat(card): add AI status pulse + glow animations`

### M3-T8: Click TodoCard → Focus Mode (active session) / edit (no session)

Modify TodoCard onClick:
- If `todo.aiSession?.sessionId` exists → `dispatchStore.openFocus(todo.id, sessionId)`
- Else → existing `onClick(todo)` (opens detail/edit)

Remove the inline `⇆` button from card (T4 is now redundant — ⇆ becomes the entire card click). KEEP the ⇆ button in the card actions hover area for explicit affordance, OR remove if it feels redundant — pick the simpler.

Commit: `feat(card): click active card opens Focus Mode`

### M3-T9: Extract QuadrantBoard from TodoManage

**Files:** Create `web/src/components/QuadrantBoard/{QuadrantBoard.tsx,QuadrantBoard.css,index.ts}`. Move:
- `QuadrantZone` inner component (line ~664)
- The 2x2 grid container JSX from TodoManage's main render
- Drag-drop sensor setup (DndContext) — KEEP if it's only used for the board; otherwise leave in TodoManage

Modify TodoManage to render `<QuadrantBoard todos={todos} ... />`.

Commit: `refactor(board): extract QuadrantBoard from TodoManage`

### M3-T10: TodoManage.tsx split — target ≤400 lines (full 3-stage review)

After T9, TodoManage should be smaller. Further extract:
- AI session handlers (handleAiExec, handleSessionRecover, etc.) → `web/src/hooks/useAiSessionHandlers.ts`
- Telegram sync state → `web/src/hooks/useTelegramSync.ts`
- New-todo drawer state → `web/src/components/NewTodoDrawer.tsx`
- Modal definitions (delete confirm, etc.) → keep inline if small

Goal: ≤400 lines. Stretch fallback: ≤600 lines acceptable with PR-description note.

Commit: `refactor(state): split TodoManage handlers into hooks`

### M3-T11: M3 verification gate

- `npm run build` PASS
- `wc -l web/src/TodoManage.tsx` ≤ 600
- `ls web/src/dock/ web/src/store/terminalDockStore.ts` returns "no such file"
- Backend tests baseline (15 reply-hub failures only)
- Tag `ui-overhaul-m3`

---

## M4: Drawer consolidation + toolbar consolidation + polish (~8 tasks)

### M4-T1: TSX inline hex literals migration

Find: `grep -rn "style={{[^}]*#[0-9a-fA-F]" web/src --include="*.tsx"`

Migrate each `style={{ color: '#888' }}` to use design tokens. Replace with `var(--text-tertiary)` etc. (literally — TSX style accepts CSS var strings).

Goal: ≤ 5 inline hex literals remaining (with comment justification).

Commit: `refactor(theme): migrate inline TSX hex literals to design tokens`

### M4-T2: Stats + Report drawer merge

**Files:** Create `web/src/components/StatsReportsDrawer/StatsReportsDrawer.tsx` that mounts an AntD `<Tabs>` with "Stats" + "Reports" tabs, embedding existing StatsDrawer body + ReportDrawer body.

In TodoManage / TopbarDispatch, replace 2 separate drawer mounts with one. Update dispatchStore: `report` flag → reuse `stats` flag (or rename to `statsReports`). Update CommandPalette and TopbarDispatch:📊 button → opens single drawer.

Migration approach: extract existing StatsDrawer + ReportDrawer body into "panel" components without their Drawer wrapper, then mount both inside StatsReportsDrawer's Tabs.

Commit: `feat(drawer): merge Stats + Reports into single drawer with Tabs`

### M4-T3: 找回 button → TopbarDispatch right side

Modify TopbarDispatch.tsx — add 找回 (recover) button next to Settings/Theme toggle. Wire to existing handler in TodoManage (need a callback prop OR move the handler to a shared location).

Simplest path: dispatchStore gains `requestRecover: boolean` flag + `requestRecoverOpen()` action; TopbarDispatch button calls the action; TodoManage useEffect watches the flag and opens the existing recover modal.

Commit: `feat(topbar): relocate 找回 button to TopbarDispatch`

### M4-T4: Telegram sync + Template — keep in ⌘K only, remove from toolbar

After T3, the second toolbar's remaining items are TelegramSyncButton + Template Dropdown entry. Confirm both are reachable via existing CommandPalette commands ("Telegram sync", "Insert from Template…"). If they exist in the palette, remove from the second toolbar.

If anything is missing in palette, add Command.Item entries.

Commit: `feat(cmdk): ensure Telegram + Template reachable via palette only`

### M4-T5: Remove the (now-empty) second toolbar

After T3 + T4, the `todo-sticky-header` may have nothing left or just the search/filter row. If the entire row is gone, remove the second sticky bar in TodoManage entirely + remove the `top: var(--topbar-dispatch-h)` from `.todo-sticky-header` in TodoManage.css (since it no longer renders).

If filter/search row remains in `todo-sticky-header`, KEEP it — just remove the action buttons that moved.

Commit: `refactor(topbar): remove orphan second toolbar after action consolidation`

### M4-T6: Mobile CSS pass

Add/refine `@media (max-width: 768px)` rules in `mobile.css` for:
- Hero TodoCard: stack action buttons under title, allow more vertical room for sparkline
- StatsReportsDrawer Tabs: ensure tabs work in narrow viewport
- SessionFocus subbar: condense further if needed (already done in M2.5)
- Topbar pills: hide labels on narrow, show only number+icon

No real-device test — best-effort based on common patterns.

Commit: `feat(mobile): refine M3+M4 components for narrow viewports`

### M4-T7: Cleanup + walkthrough doc

- Run all gate checks (build, hex count, TodoManage line count, backend tests baseline)
- Write `docs/superpowers/specs/2026-05-12-ui-overhaul-final-walkthrough.md` — what changed M1→M4, screenshots TODO list (for user)
- No code change unless gate fails

Commit: `docs: M3+M4 final walkthrough notes`

### M4-T8: M4 verification gate + tag

Tag `ui-overhaul-m4`. Final final.

---

## Acceptance criteria (combined)

| Criterion | Pass | Verification |
|---|---|---|
| Hero TodoCard renders | Card matches mockup layout | Manual walkthrough |
| Sparkline shows real activity | Visible electric-blue line for running sessions | Manual + dev console |
| dock/ deleted | `ls web/src/dock` returns no such file | Build clean |
| TodoManage shrunk | ≤ 600 lines (target 400) | `wc -l` |
| Drawers consolidated | Single Stats+Reports drawer | UI walkthrough |
| 找回 in topbar | Button visible in TopbarDispatch | UI walkthrough |
| Second toolbar removed | Only TopbarDispatch remains | UI walkthrough |
| TSX inline hex migrated | ≤ 5 with comments | `grep` |
| Build clean | `npm run build` PASS | CI |
| Backend tests baseline | 15 pre-existing failures only | `npx vitest run --pool=forks` |
| Mobile rules added | New media queries in mobile.css | Code inspection |
| Tags set | ui-overhaul-m3 + ui-overhaul-m4 | `git tag --list` |

---

## Risk register

| Risk | Mitigation |
|---|---|
| Hero TodoCard breaks dnd-kit drag | Keep setNodeRef + attributes + listeners on the outer div; test drag via build only |
| TodoManage split breaks lifted state from M2 (dispatchStore) | Move state-driven logic atomically; verify selectors still resolve |
| Drawer merge breaks existing Stats / Reports content rendering | Extract bodies as panel components, mount both in Tabs |
| 找回 modal triggered from TopbarDispatch but logic in TodoManage | Use dispatchStore flag pattern (same as requestNewTodo from M2) |
| Mobile rules guess wrong without device test | Use safe defaults (hide labels on narrow, allow scroll); user can refine |
| Hero TodoCard visual feels off | Each commit is reverted independently; user can cherry-pick |

---

## Out of scope (explicitly)

- Real "Log 日志" raw text tab (needs backend log API)
- Mobile real-device QA
- Performance baseline measurement
- A11y audit
- i18n
- Any backend code changes
- New features beyond mockup
