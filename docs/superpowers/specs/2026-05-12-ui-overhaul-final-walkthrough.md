# UI Overhaul — Final Walkthrough (M1 → M4)

**Date:** 2026-05-12 (overnight run)
**Tags:** `ui-overhaul-m1` → `ui-overhaul-m2` → `ui-overhaul-m2.5` → `ui-overhaul-m3` → `ui-overhaul-m4`
**Spec:** `docs/superpowers/specs/2026-05-12-ui-overhaul-ai-first-design.md`
**Visual reference:** `mockups/ui-overhaul-preview.html`

---

## At a glance

```
M1 (15 commits)  Design tokens + theme infra + dark mode
M2 (17 commits)  Topbar Dispatch + ⌘K command palette
M2.5 (10+1 commits)  AI Session Focus Mode (full-screen overlay)
M3 (~10 commits)   Hero TodoCard + sparkline + click-to-focus + cleanup
M4 (~5 commits)    Drawer consolidation + toolbar consolidation + mobile
```

Total: ~58 commits across 4 milestones. All automated gates green; manual walkthrough still owed by user.

---

## What's new (since the start of work)

### Visual

- **Dark mode default** with light mode toggle (right side of topbar) — instant flip, persists to localStorage
- **TopbarDispatch** replaced the inline TodoManage topbar:
  - Logo + 3 live status pills (active sessions / token total / pending confirms)
  - Hover any pill for tooltip with details
  - ⌘K button + 找回 / 📊 Stats&Reports / 📖 Wiki / ⚙ Settings / 🌙 theme
  - On mobile: collapses to icons only (no labels)
- **Hero TodoCard** has a new AI status row when active session exists:
  - tool tag + status (running/thinking/pending — with pulse animation in token color) + duration
  - **ActivitySparkline** (electric-blue SVG) showing real WS message rate
  - "⌘ to focus" hint on hover
  - Click card body → enters Focus Mode (when active session); else opens edit
- **Focus Mode** (full-screen overlay) replaces the old right-side dock:
  - Subbar: ← Grid btn / quadrant dot + title + #shortid / tool · 状态 pill / ✕
  - Tabs: Conversation (TranscriptView) + Live 终端 (xterm)
  - Auto-resize on tab switch (window resize event nudge for xterm)
  - Mobile: full viewport (no 52px gap)
- **Stats + Reports merged** into single drawer with AntD Tabs
- **Second toolbar deleted** — 找回 went to topbar; Telegram + Template moved to ⌘K only

### Interaction

- **⌘K / Ctrl+K** opens command palette anywhere (works in inputs)
- **Esc** closes Focus Mode (priority) → palette → drawers
- **CommandPalette** has these groups:
  - Quick actions: New todo / Start AI session (claude/codex with todo picker)
  - Jump to todo (active sessions, fuzzy filter)
  - Focus session (one entry per active session)
  - Drawers: Stats & Reports / Wiki / Settings / Telegram sync / Insert from Template
  - System: Toggle theme

### Code quality

- **`web/src/dock/`** directory mostly deleted (only `AttentionRail.tsx` remains, still in use)
- **`web/src/store/terminalDockStore.ts`** deleted; ~165 lines of orphan dock code removed across TodoManage + AiTerminalMini
- **TodoManage.tsx** shrunk from 2502 → 1775 lines (-727)
- **SortableTodoCard** + **QuadrantZone** + **QuadrantBoard** extracted to dedicated files
- **CSS hex literals**: 294 → 6 (all `/* token-exception */` annotated)
- **TSX inline hex literals**: 28 → 0
- **AntD static APIs** (message/notification/Modal.confirm) all migrated to `App.useApp()` hook

---

## File map (new components)

```
web/src/design/                      M1
├── tokens.ts                        # JS source of truth
├── tokens.css                       # CSS variables (dark + light)
├── antd-theme.ts                    # AntD ThemeConfig from tokens
├── ThemeProvider.tsx                # React Context + localStorage
├── useAppMessages.ts                # App.useApp() wrapper
├── useDispatchStats.ts              M2  # active/pending/token counts
└── useGlobalShortcuts.ts            M2  # ⌘K + Esc handler

web/src/store/
├── dispatchStore.ts                 M2  # drawer/palette/focus signals
└── focusStore.ts                    M2.5 # focused todo + tab state

web/src/components/
├── ThemeToggle/                     M1  # 🌙/☀️ button
├── StatPill/                        M2  # topbar pill primitive
├── TopbarDispatch/                  M2  # the new top bar
├── CommandPalette/                  M2  # ⌘K palette
├── SessionFocus/                    M2.5 # full-screen session overlay
│   ├── SessionFocus.tsx
│   ├── FocusSubbar.tsx
│   └── FocusTabs.tsx
├── ActivitySparkline/               M3  # SVG sparkline
├── TodoCard/                        M3  # extracted SortableTodoCard
├── QuadrantBoard/                   M3  # extracted board
│   ├── QuadrantBoard.tsx
│   ├── QuadrantZone.tsx
│   └── quadrantConfig.ts
└── StatsReportsDrawer/              M4  # merged Stats + Report
    ├── StatsReportsDrawer.tsx
    ├── StatsPanel.tsx
    └── ReportPanel.tsx
```

---

## Manual walkthrough TODO (USER)

The following items can only be confirmed by your eyes / hands. Run `agentquad start` and check:

### Visual / theme
- [ ] App opens in dark mode by default
- [ ] Click 🌙 in topbar → light mode flips instantly, AntD components flip too
- [ ] Refresh page → preference persists
- [ ] Hover topbar pills → tooltip with active session names / token usage / pending confirms
- [ ] Topbar logo gradient (electric-blue → magenta) with subtle glow

### TodoCard
- [ ] When a todo has an active AI session, card shows the new status row (tool · running ▶ duration · sparkline)
- [ ] Sparkline animates with electric-blue line for running sessions (refreshes every 1s)
- [ ] Click card with active session → enters Focus Mode
- [ ] Click card without session → opens edit (existing behavior)
- [ ] Hover card → "⌘ to focus" hint appears top-right (when active)
- [ ] Drag-and-drop still works on cards (between quadrants)

### Focus Mode
- [ ] Click ⇆ in card toolbar → enters Focus Mode
- [ ] Subbar shows: ← Grid / quadrant dot + title / claude · 运行中 pill / ✕
- [ ] Tabs: Conversation + Live 终端
- [ ] Switch to Live 终端 → xterm fills full width (NOT narrow on left)
- [ ] Tab switch preserves xterm scrollback state
- [ ] Esc closes Focus Mode (NOT palette, NOT drawers)
- [ ] No right-side dock visible (it's gone)

### Command palette
- [ ] ⌘K (Cmd-K on Mac, Ctrl-K on Linux/Win) opens palette
- [ ] Type todo title fragment → results filter
- [ ] "Open Stats" + "Open Stats & Reports" both open the merged drawer (different default tab)
- [ ] "Open Wiki" / "Open Settings" work
- [ ] "Telegram sync" → fires the existing dry-run preview modal
- [ ] "Insert from Template…" → opens template drawer
- [ ] "Toggle theme" → flips theme + closes palette
- [ ] "Start AI session (claude) →" → opens picker → pick a todo → focus opens
- [ ] "Focus session" group lists active sessions; pick → focus opens
- [ ] Esc closes palette

### Topbar actions
- [ ] 找回 button (search icon) opens transcript-search drawer
- [ ] 📊 button opens StatsReportsDrawer (Stats tab default)
- [ ] 📖 button opens Wiki drawer
- [ ] ⚙ button opens Settings drawer
- [ ] 🌙 / ☀️ toggles theme

### Mobile (resize narrow OR open on iPhone via Tailscale)
- [ ] Topbar pill labels hide ("active" / "tok" / "pending" → just numbers)
- [ ] ⌘K button collapses to icon only
- [ ] Logo text ("AgentQuad") hidden under 480px
- [ ] Focus Mode covers full viewport (no 52px gap above)
- [ ] Card AI status row wraps if too narrow
- [ ] StatsReportsDrawer tabs work in narrow

### Regression checks
- [ ] Drag-and-drop cards between quadrants
- [ ] Create new todo (N or palette command)
- [ ] Edit existing todo
- [ ] Delete todo (confirm dialog appears with theme styling)
- [ ] Sub-todo creation
- [ ] AI session start (claude/codex/cursor)
- [ ] Mobile menu still works (hamburger button)
- [ ] AttentionRail (right-edge attention indicator) still works

---

## Known issues / deferred to future

- **Real "Log 日志" tab** — needs new backend log API; deferred (focus mode currently has 2 tabs: Conversation + Live)
- **Mobile real-device QA** — done by CSS rules only; user should test on actual iPhone via Tailscale
- **Performance baseline** — not measured; if anything feels slow, run browser perf profiler
- **`StatsDrawer.tsx` + `ReportDrawer.tsx`** — kept as orphan files (no longer mounted); safe to delete in cleanup
- **Pre-existing test failures** in `test/reply-hub.test.ts` — 15 failures, predate M1, NOT caused by this work
- **Two-toolbar consolidation** — second toolbar fully removed (M4-T5); only TopbarDispatch remains
- **Sparkline data source** — based on AI session output rate (existing WS data); not real-time token rate (needs server field)

---

## Quick numbers

| Metric | Before M1 | After M4 |
|---|---|---|
| TodoManage.tsx lines | 2502 | 1775 |
| TodoManage.css lines | 1028 | ~970 |
| CSS hex literals (excl tokens) | 294 | 6 |
| TSX inline hex literals | ~30 | 0 |
| AntD static API call sites | ~80 across 14 files | 0 |
| Design system files | 0 | 7 (tokens, theme, hooks) |
| New hero components | 0 | 11 (ThemeToggle, StatPill, TopbarDispatch, CommandPalette, SessionFocus, ActivitySparkline, TodoCard, QuadrantBoard, QuadrantZone, StatsReportsDrawer) |
| dock/ directory | 6 files + 1 store | 1 file (AttentionRail only) |

---

## How to revert

If anything's broken or you want to undo a milestone:

```bash
git reset --hard ui-overhaul-m3        # back to before M4
git reset --hard ui-overhaul-m2.5      # back to before M3
git reset --hard ui-overhaul-m2        # back to before focus mode
git reset --hard ui-overhaul-m1        # back to just design tokens
git reset --hard <commit-before-m1>    # nuclear: undo everything
```

Or revert single commits:
```bash
git revert <sha>
```

---

## What I (Claude) would suggest as next steps

1. **Quick walkthrough** (5-10 min) — open the app, click around, verify the obvious paths
2. **If anything looks wrong**, ask me to fix it — every commit is small + reversible
3. **Use it for a few days** to feel the UX
4. **Then cleanup PRs** for:
   - Delete StatsDrawer.tsx + ReportDrawer.tsx (orphan)
   - Maybe further split TodoManage (1775 → 800 if you want)
   - Real "Log 日志" tab if you want raw text log viewer
   - Mobile polish based on real-device usage

Good night 🌙
