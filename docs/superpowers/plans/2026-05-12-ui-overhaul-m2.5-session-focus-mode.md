# UI Overhaul — M2.5: AI Session Focus Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the AI session view (currently a fixed-size right-side dock) into a **full-screen Focus Mode** overlay that the user can enter from any session card or the command palette. Style matches the mockup: top sub-bar (back / task title / pill row / action icons / close) → tab switcher (Conversation / Live 终端) → content (reuses existing SessionViewer) → footer (status line + input — currently from AiTerminalMini's chrome).

**Architecture:**
- **Reuse, don't rewrite.** `SessionViewer.tsx` already wraps `AiTerminalMini` (Live 终端) + `TranscriptView` (Conversation), with a Segmented switcher and display:none/flex preserving xterm/WS state across tab switches. Focus Mode just wraps this with a full-screen overlay + new sub-bar chrome.
- **State:** `focusStore` (zustand) holds `focusedTodoId` + `focusedSessionId`. Set via `dispatchStore` action `openFocus(todoId, sessionId)`. Main.tsx mounts a single `<SessionFocus />` that reads the store and renders the overlay when set.
- **Trigger surfaces:** ⇆ button on `TerminalDockTab` chrome; "Focus on session..." entries in CommandPalette (one per active session); future: click on TodoCard (M3).
- **Esc priority:** focus open → closes focus (highest); palette open → closes palette; otherwise drawerStackStore handles.

**Tech Stack:** React 18 + TS + zustand 5 + AntD 5. No new deps. Builds on M1 tokens + M2 dispatchStore + cmdk.

**Spec reference:** `docs/superpowers/specs/2026-05-12-ui-overhaul-ai-first-design.md` § "AI 终端可视化升级"
**Visual reference:** `mockups/ui-overhaul-preview.html` (click any card → Focus Mode demo)
**Builds on:** M1 (tagged `ui-overhaul-m1`) + M2 (tagged `ui-overhaul-m2`)

---

## Resolved decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Existing right-side dock | **(a) Keep**, add ⇆ button to expand to Focus Mode |
| 2 | Tab content | **(α) Reuse existing SessionViewer's Live/Conversation 2-tab system** — rename "Log 日志" → "Conversation" for clarity. NO new "Log 日志" raw-text tab in M2.5 (deferred to M3 if needed; would require backend log API). |
| 3 | Scope | **(I) MVP wrapper** — full-screen overlay + sub-bar chrome + tab switcher + reuse SessionViewer guts. Existing footer (status line + input) stays where AiTerminalMini renders it for now. |

---

## File Structure

**New files:**
- `web/src/store/focusStore.ts` — zustand: `focusedTodoId`, `focusedSessionId`, `focusedTab` (`'conversation' | 'live'`), setters
- `web/src/components/SessionFocus/SessionFocus.tsx` — full-screen overlay; renders null when not focused; mounts SessionViewer
- `web/src/components/SessionFocus/SessionFocus.css`
- `web/src/components/SessionFocus/FocusSubbar.tsx` — top chrome: ← Grid btn / quadrant dot + title + #shortid / `claude · 全托管` pill / `跟随` pill / icon actions / close
- `web/src/components/SessionFocus/FocusTabs.tsx` — `Conversation / Live 终端` tab switcher; mockup styling (electric underline)
- `web/src/components/SessionFocus/index.ts`

**Modified files:**
- `web/src/store/dispatchStore.ts` — add `openFocus(todoId: string, sessionId?: string)` action that sets focusStore values; add a "close focus" intent if needed
- `web/src/components/CommandPalette/CommandPalette.tsx` — add "Focus on session" group; one entry per active todo with a session
- `web/src/design/useGlobalShortcuts.ts` — add Esc handling: focus open → close focus (priority over palette/drawer); add optional `⌘ + .` or `f` to toggle focus on currently-active session (skip if hard)
- `web/src/dock/TerminalDockTab.tsx` — add ⇆ button to the dock tab header that calls `openFocus(todoId, sessionId)`
- `web/src/SessionViewer.tsx` — add optional `hideTabs?: boolean` prop. When true, the inner Segmented switcher hides (Focus Mode owns the tabs externally) and SessionViewer accepts an external `mode` value via prop. This avoids two switchers showing in Focus Mode.
- `web/src/main.tsx` — mount `<SessionFocus />` inside `<AntdApp>` as a sibling of `<TodoManage />` and `<CommandPalette />`
- `web/src/mobile.css` — focus mode full-screen rules (focus must work on mobile too — the Tailscale phone use case)

**Files we do NOT touch in M2.5:**
- AiTerminalMini's existing footer/input (it stays inside the AiTerminalMini render — Focus Mode just gives it more room)
- Backend (no new APIs)
- TodoCard / quadrant board (M3)
- Drawer consolidation (M4)
- Real "raw log" tab (deferred — needs backend log-fetching API)

---

## Conventions for this milestone

- Focus Mode is a **single global overlay** (not per-todo state) — only one session can be in focus at a time. This mirrors how the mockup works.
- Sub-bar chrome reads from `aiSessionStore.sessions.get(focusedSessionId)` for status / tool / todoTitle. Pills reflect live session state.
- Tab switching uses controlled `value` prop on SessionViewer (when `hideTabs={true}`) — driven by focusStore.focusedTab.
- Keep `dispatchStore` clean: ONLY add `openFocus`. The actual `focusedTodoId` etc. live in the new `focusStore` to avoid mixing dispatch signals with focus state. `openFocus` calls `useFocusStore.getState().setFocus(...)`.
- One commit per task. Use `feat(focus):` / `refactor(viewer):` prefixes.

---

## Task 1: Build focusStore

**Files:**
- Create: `web/src/store/focusStore.ts`

- [ ] **Step 1: Write focusStore.ts**

```ts
import { create } from 'zustand'

export type FocusTab = 'conversation' | 'live'

interface FocusState {
  /** Currently-focused todo (null = no focus / Grid mode) */
  focusedTodoId: string | null
  /** The session ID being shown in focus (may be null if todo has no active session) */
  focusedSessionId: string | null
  /** Active tab inside Focus Mode */
  focusedTab: FocusTab

  setFocus: (todoId: string | null, sessionId?: string | null) => void
  clearFocus: () => void
  setTab: (tab: FocusTab) => void
}

export const useFocusStore = create<FocusState>((set) => ({
  focusedTodoId: null,
  focusedSessionId: null,
  focusedTab: 'conversation',  // Default landing tab matches mockup (rendered chat first)

  setFocus: (todoId, sessionId) => set(() => ({
    focusedTodoId: todoId,
    focusedSessionId: sessionId ?? null,
    focusedTab: 'conversation',  // Reset tab on new focus
  })),
  clearFocus: () => set(() => ({ focusedTodoId: null, focusedSessionId: null })),
  setTab: (tab) => set(() => ({ focusedTab: tab })),
}))
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/store/focusStore.ts
git commit -m "feat(focus): add focusStore (zustand) for session focus mode state"
```

---

## Task 2: Add openFocus action to dispatchStore

**Files:**
- Modify: `web/src/store/dispatchStore.ts`

- [ ] **Step 1: Read current dispatchStore.ts**

```bash
cat web/src/store/dispatchStore.ts
```

- [ ] **Step 2: Add `openFocus` action**

In the `DispatchState` interface, add (next to `openPalette` etc.):
```ts
  /** Open the session focus overlay for the given todo (and its session, if known). Closes palette. */
  openFocus: (todoId: string, sessionId?: string | null) => void
```

In the store body, add the action implementation. We'll need to import `useFocusStore` lazily to avoid circular concerns:
```ts
  openFocus: (todoId, sessionId) => {
    // Close any open palette/drawers, then activate focus
    set(() => ({ palette: false, settings: false, stats: false, wiki: false, report: false }))
    // Lazy import to avoid TDZ issue with cross-store reference
    import('./focusStore').then(({ useFocusStore }) => {
      useFocusStore.getState().setFocus(todoId, sessionId ?? null)
    })
  },
```

If the dynamic import feels off, an alternative is to import at top:
```ts
import { useFocusStore } from './focusStore'
```
and call directly:
```ts
  openFocus: (todoId, sessionId) => {
    set(() => ({ palette: false, settings: false, stats: false, wiki: false, report: false }))
    useFocusStore.getState().setFocus(todoId, sessionId ?? null)
  },
```

The static import is fine because focusStore has no dispatchStore dependency (one-way reference). Use static.

- [ ] **Step 3: Verify**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add web/src/store/dispatchStore.ts
git commit -m "feat(focus): add openFocus action on dispatchStore"
```

---

## Task 3: Modify SessionViewer to accept external tab control

**Files:**
- Modify: `web/src/SessionViewer.tsx`

This is necessary because in Focus Mode, the OUTER chrome (FocusTabs) owns the tab state. We need SessionViewer to optionally hide its inner Segmented switcher and accept an external `mode` value.

- [ ] **Step 1: Read the full current SessionViewer.tsx**

```bash
cat web/src/SessionViewer.tsx
```

- [ ] **Step 2: Add optional props**

Modify the `Props` interface (after `fillHeight`):
```ts
  /** When true, the inner Segmented switcher is hidden (caller renders its own tabs). */
  hideTabs?: boolean
  /** Controlled mode value (only used when hideTabs is true). */
  mode?: ViewMode
  /** Notification when the inner switcher changes mode (only fires when hideTabs is false). */
  onModeChange?: (mode: ViewMode) => void
```

(The `ViewMode` type is `'live' | 'transcript'` per current code. Keep that type — Focus Mode will translate `'conversation' | 'live'` to `'transcript' | 'live'` at call site.)

In the component body, change the local state to use the controlled prop when provided:
```ts
const [internalMode, setInternalMode] = useState<ViewMode>('live')
const mode = props.mode ?? internalMode
const setMode = (next: ViewMode) => {
  if (props.mode === undefined) setInternalMode(next)
  props.onModeChange?.(next)
}
```

In the JSX, conditionally render the Segmented switcher:
```tsx
{!props.hideTabs && (
  <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0, padding: '2px 6px 0' }}>
    <Segmented
      size="small"
      value={mode}
      onChange={(v) => setMode(v as ViewMode)}
      options={[
        { label: 'Live 终端', value: 'live' },
        { label: 'Log 日志', value: 'transcript' },
      ]}
    />
  </div>
)}
```

- [ ] **Step 3: Verify**

```bash
cd web && npx tsc --noEmit
cd web && npm run build
```

Both must PASS. The existing callsites (`PipelineRunDrawer.tsx`, `dock/TerminalDockTab.tsx`) don't pass `hideTabs` so they keep current behavior.

- [ ] **Step 4: Commit**

```bash
git add web/src/SessionViewer.tsx
git commit -m "refactor(viewer): allow external tab control via hideTabs/mode props"
```

---

## Task 4: Build SessionFocus overlay skeleton

**Files:**
- Create: `web/src/components/SessionFocus/SessionFocus.tsx`
- Create: `web/src/components/SessionFocus/SessionFocus.css`
- Create: `web/src/components/SessionFocus/index.ts`

- [ ] **Step 1: Write SessionFocus.tsx (skeleton — sub-bar + tabs + content area placeholder)**

```tsx
import { useFocusStore } from '../../store/focusStore'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { FocusSubbar } from './FocusSubbar'
import { FocusTabs } from './FocusTabs'
import SessionViewer from '../../SessionViewer'
import './SessionFocus.css'

export function SessionFocus() {
  const focusedTodoId = useFocusStore((s) => s.focusedTodoId)
  const focusedSessionId = useFocusStore((s) => s.focusedSessionId)
  const focusedTab = useFocusStore((s) => s.focusedTab)
  const setTab = useFocusStore((s) => s.setTab)
  const clearFocus = useFocusStore((s) => s.clearFocus)

  const sessions = useAiSessionStore((s) => s.sessions)

  if (!focusedTodoId) return null

  // Try to look up the active session for this todo from store
  const session = focusedSessionId ? sessions.get(focusedSessionId) : undefined

  // Map our 'conversation' | 'live' tab → SessionViewer's 'transcript' | 'live'
  const sessionViewerMode = focusedTab === 'conversation' ? 'transcript' : 'live'

  return (
    <div className="session-focus">
      <FocusSubbar
        todoId={focusedTodoId}
        sessionId={focusedSessionId}
        session={session}
        onClose={clearFocus}
      />
      <FocusTabs
        value={focusedTab}
        onChange={setTab}
      />
      <div className="session-focus-content">
        {focusedSessionId && session ? (
          <SessionViewer
            sessionId={focusedSessionId}
            todoId={focusedTodoId}
            status={session.status === 'running' || session.status === 'pending_confirm' ? 'ai_running' : 'ai_done'}
            cwd={session.cwd ?? null}
            onClose={clearFocus}
            hideTabs
            mode={sessionViewerMode}
            fillHeight
          />
        ) : (
          <div className="session-focus-empty">
            No active session for this todo.
          </div>
        )}
      </div>
    </div>
  )
}
```

NOTES on the JSX above:
- `status` mapping is naive (running/pending → 'ai_running', else 'ai_done'). If the actual `TodoStatus` type has a richer set, look it up and refine. The status only affects autoRefresh timing inside SessionViewer, so being approximate is OK for MVP.
- `cwd` may not be on `SessionMeta` directly; if it's `undefined`, pass `null`.
- If SessionViewer needs other props (resumeTarget, onSessionRecovered, etc.), pass `undefined`/`null` for MVP — those are optional.

- [ ] **Step 2: Write SessionFocus.css**

```css
.session-focus {
  position: fixed;
  inset: 52px 0 0 0;  /* below TopbarDispatch */
  background: var(--surface-0);
  z-index: 80;        /* below cmdk overlay (200), above dock */
  display: flex;
  flex-direction: column;
  animation: focus-in var(--motion-normal) var(--ease-out);
}

@keyframes focus-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.session-focus-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.session-focus-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
```

- [ ] **Step 3: Write index.ts**

```ts
export { SessionFocus } from './SessionFocus'
```

- [ ] **Step 4: Verify**

```bash
cd web && npx tsc --noEmit
```

This will FAIL because FocusSubbar and FocusTabs don't exist yet. That's expected — Tasks 5+6 add them. SKIP the build verification here, just check the file is syntactically OK by reading it.

- [ ] **Step 5: Commit (intentionally broken — will be fixed by T5+T6)**

Don't commit yet — bundle with T5+T6. Skip this step.

---

## Task 5: Build FocusSubbar component

**Files:**
- Create: `web/src/components/SessionFocus/FocusSubbar.tsx`

The sub-bar shows: ← Grid button / quadrant color dot + task title + #shortid / `claude · 全托管` pill / `跟随` pill / icon actions / close.

- [ ] **Step 1: Write FocusSubbar.tsx**

```tsx
import { Tooltip } from 'antd'
import type { SessionMeta } from '../../store/aiSessionStore'

interface Props {
  todoId: string
  sessionId: string | null
  session?: SessionMeta
  onClose: () => void
}

export function FocusSubbar({ session, onClose }: Props) {
  const title = session?.todoTitle ?? '(untitled)'
  const tool = session?.tool ?? 'ai'
  const status = session?.status ?? 'idle'
  const sessionShortId = session?.sessionId?.slice(0, 8) ?? '—'
  const quadrant = session?.quadrant ?? 0

  const quadColor = quadrant >= 1 && quadrant <= 4 ? `var(--q${quadrant})` : 'var(--text-tertiary)'

  return (
    <div className="focus-subbar">
      <button className="focus-back" onClick={onClose} aria-label="Back to grid">
        <span>←</span>
        <span>Grid</span>
      </button>
      <div className="focus-task-title">
        <span className="quad-dot" style={{ background: quadColor, boxShadow: `0 0 8px ${quadColor}` }} />
        <span>{title}</span>
        <span className="focus-task-id">#{sessionShortId}</span>
      </div>
      <div className="focus-actions">
        <span className="pill-select green">{tool} · {status === 'running' ? '运行中' : status === 'pending_confirm' ? '待确认' : 'idle'}</span>
        <Tooltip title="Close (Esc)">
          <button className="focus-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </Tooltip>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add styles to SessionFocus.css**

Append to `web/src/components/SessionFocus/SessionFocus.css`:

```css
.focus-subbar {
  height: 44px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 10px;
  flex-shrink: 0;
}

.focus-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: all var(--motion-fast) var(--ease-standard);
}
.focus-back:hover {
  background: var(--surface-2);
  color: var(--text-primary);
  border-color: var(--border-default);
}

.focus-task-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--text-primary);
}
.focus-task-title .quad-dot {
  width: 9px; height: 9px; border-radius: 50%;
}
.focus-task-id {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  margin-left: 6px;
}

.focus-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pill-select {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.pill-select.green {
  border-color: var(--ai-running);
  color: var(--ai-running);
  background: color-mix(in srgb, var(--ai-running) 10%, transparent);
}
.focus-icon-btn {
  width: 28px; height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--text-md);
  cursor: pointer;
  transition: all var(--motion-fast) var(--ease-standard);
}
.focus-icon-btn:hover {
  background: var(--surface-2);
  color: var(--text-primary);
  border-color: var(--border-subtle);
}
```

- [ ] **Step 3: Verify (still expects FocusTabs to exist next)**

Skip build check until T6.

---

## Task 6: Build FocusTabs component + commit T4-T6 together

**Files:**
- Create: `web/src/components/SessionFocus/FocusTabs.tsx`

- [ ] **Step 1: Write FocusTabs.tsx**

```tsx
import type { FocusTab } from '../../store/focusStore'

interface Props {
  value: FocusTab
  onChange: (tab: FocusTab) => void
}

const TABS: { key: FocusTab; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'live', label: 'Live 终端' },
]

export function FocusTabs({ value, onChange }: Props) {
  return (
    <div className="focus-tabs">
      {TABS.map((t) => (
        <button
          key={t.key}
          className={`focus-tab${value === t.key ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add styles to SessionFocus.css**

Append:

```css
.focus-tabs {
  display: flex;
  align-items: center;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface-0);
  gap: 2px;
  flex-shrink: 0;
}
.focus-tab {
  padding: 10px 14px;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  font-family: var(--font-sans);
  transition: color var(--motion-fast) var(--ease-standard);
}
.focus-tab:hover { color: var(--text-secondary); }
.focus-tab.active {
  color: var(--accent-electric);
  border-bottom-color: var(--accent-electric);
}
```

- [ ] **Step 3: Verify build (now T4-T6 are all in place)**

```bash
cd web && npx tsc --noEmit
cd web && npm run build
```
Both must PASS.

If `SessionMeta` doesn't have a `quadrant` field at the top level (it might come from a related Todo not the SessionMeta directly), the FocusSubbar's `quadrant` access may need adjustment. Look at `LiveSession` definition in `api.ts` to confirm. If it's missing, render the dot with neutral color (`var(--text-tertiary)`) for MVP — no functional regression.

- [ ] **Step 4: Commit T4 + T5 + T6 in one commit**

```bash
git add web/src/components/SessionFocus/
git commit -m "feat(focus): add SessionFocus overlay with sub-bar + tabs"
```

---

## Task 7: Mount SessionFocus in main.tsx

**Files:**
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Read current main.tsx**

```bash
cat web/src/main.tsx
```

- [ ] **Step 2: Add SessionFocus to ThemedApp**

Add the import:
```ts
import { SessionFocus } from './components/SessionFocus'
```

In the ThemedApp's JSX, mount `<SessionFocus />` as a sibling of `<TodoManage />` and `<CommandPalette />`:

```tsx
function ThemedApp() {
  const { mode } = useTheme()
  useGlobalShortcuts()
  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(mode)}>
      <AntdApp message={{ maxCount: 3 }}>
        <TodoManage />
        <CommandPalette />
        <SessionFocus />
      </AntdApp>
    </ConfigProvider>
  )
}
```

- [ ] **Step 3: Verify build + smoke**

```bash
cd web && npm run build
cd web && npm run dev  # background
sleep 2
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
pkill -f vite || true
```

- [ ] **Step 4: Commit**

```bash
git add web/src/main.tsx
git commit -m "feat(focus): mount SessionFocus globally in ThemedApp"
```

---

## Task 8: Add ⇆ button to TerminalDockTab to trigger Focus Mode

**Files:**
- Modify: `web/src/dock/TerminalDockTab.tsx`

- [ ] **Step 1: Read current TerminalDockTab.tsx**

```bash
cat web/src/dock/TerminalDockTab.tsx
```

- [ ] **Step 2: Add an "Open in Focus Mode" button**

Locate where SessionViewer is rendered (around line 62 per earlier grep). Find the surrounding chrome (header? toolbar?). Add a small button somewhere visible — top-right of the tab is the natural spot.

Add the import:
```ts
import { useDispatchStore } from '../store/dispatchStore'
import { Tooltip } from 'antd'
```

Mount the button (adjust placement based on actual file structure):
```tsx
<Tooltip title="Open in Focus Mode (full-screen)">
  <button
    className="terminal-dock-focus-btn"
    onClick={() => useDispatchStore.getState().openFocus(todoId, sessionId)}
    aria-label="Open in Focus Mode"
  >
    ⇆
  </button>
</Tooltip>
```

If the file already has a CSS file, add the rule there. Otherwise add inline styles or use existing `.terminal-dock-*` rules. Aim for something like:

```css
.terminal-dock-focus-btn {
  width: 24px; height: 24px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  cursor: pointer;
  display: grid;
  place-items: center;
  font-size: var(--text-sm);
  transition: all var(--motion-fast) var(--ease-standard);
}
.terminal-dock-focus-btn:hover {
  background: var(--accent-electric-soft);
  color: var(--accent-electric);
  border-color: var(--accent-electric);
}
```

If the dock has a `.css` file at `web/src/dock/dock.css`, add the rule there. Otherwise scope it to the component.

- [ ] **Step 3: Verify the button is reachable**

Make sure `todoId` + `sessionId` are in scope at the placement point (they should be — TerminalDockTab receives them as props).

- [ ] **Step 4: Build + smoke test**

```bash
cd web && npm run build
cd web && npm run dev  # background
sleep 2
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
pkill -f vite || true
```

- [ ] **Step 5: Commit**

```bash
git add web/src/dock/TerminalDockTab.tsx web/src/dock/dock.css
git commit -m "feat(focus): add ⇆ button to TerminalDockTab to open Focus Mode"
```

(Adjust `git add` to match files actually modified.)

---

## Task 9: Esc closes Focus Mode (priority over palette)

**Files:**
- Modify: `web/src/design/useGlobalShortcuts.ts`

- [ ] **Step 1: Update Esc handling**

Currently `useGlobalShortcuts` does:
```ts
if (e.key === 'Escape' && !isTypingInForm) {
  closePalette()
}
```

Change to give Focus Mode priority:
```ts
if (e.key === 'Escape' && !isTypingInForm) {
  // Priority: focus → palette → drawerStack handles drawers separately
  const focusOpen = useFocusStore.getState().focusedTodoId !== null
  if (focusOpen) {
    useFocusStore.getState().clearFocus()
    return
  }
  closePalette()
}
```

Add the import at the top:
```ts
import { useFocusStore } from '../store/focusStore'
```

- [ ] **Step 2: Verify**

```bash
cd web && npx tsc --noEmit
cd web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add web/src/design/useGlobalShortcuts.ts
git commit -m "feat(focus): Esc closes Focus Mode with priority over palette"
```

---

## Task 10: Add "Focus on session" entries to CommandPalette

**Files:**
- Modify: `web/src/components/CommandPalette/CommandPalette.tsx`

- [ ] **Step 1: Add a new "Focus session" group**

Read the current CommandPalette.tsx. The `default` page already has a "Jump to todo" group. We add a parallel "Focus session" group right above or below it.

Add the import:
```ts
import { useFocusStore } from '../../store/focusStore'
```

Inside the default page JSX, add a new group (only renders if there are sessions):

```tsx
{todos.length > 0 && (
  <Command.Group heading="Focus session">
    {todos
      .filter((t) => t.tool)  // only show entries that actually have a session attached
      .map((t) => (
        <Command.Item
          key={`focus-${t.id}`}
          value={`focus-${t.id}-${t.title}`}
          onSelect={() => {
            // Find the sessionId for this todo
            const sessions = useAiSessionStore.getState().sessions
            let sid: string | null = null
            sessions.forEach((s) => {
              if (s.todoId === t.id) sid = s.sessionId
            })
            useDispatchStore.getState().openFocus(t.id, sid)
            closePalette()
          }}
        >
          <span className="cmdk-icon">⇆</span>
          <span>Focus: {t.title}</span>
          {t.tool && <span className="cmdk-meta">{t.tool}</span>}
        </Command.Item>
      ))}
  </Command.Group>
)}
```

If `useFocusStore` import is not actually needed here (we use `openFocus` from dispatchStore which already wires to focusStore), remove that import.

- [ ] **Step 2: Build + smoke**

```bash
cd web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add web/src/components/CommandPalette/CommandPalette.tsx
git commit -m "feat(focus): add 'Focus session' group to CommandPalette"
```

---

## Task 11: Mobile adapt for Focus Mode

**Files:**
- Modify: `web/src/mobile.css`

The Focus Mode overlay uses `inset: 52px 0 0 0` to sit below TopbarDispatch. On mobile, TopbarDispatch isn't rendered, so it should be `inset: 0` instead.

- [ ] **Step 1: Add mobile rules**

In `web/src/mobile.css`, find or create a `@media (max-width: 768px)` block and add:

```css
.session-focus {
  inset: 0;  /* No TopbarDispatch on mobile, use full viewport */
}

/* Sub-bar layout adapts: shrink action pills, drop ID */
.focus-task-id {
  display: none;  /* Conserve horizontal space */
}
.focus-subbar {
  padding: 0 8px;
  gap: 6px;
}
```

- [ ] **Step 2: Verify build**

```bash
cd web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add web/src/mobile.css
git commit -m "feat(focus): mobile adapt for SessionFocus overlay"
```

---

## Task 12: Verification gate

**No code changes unless something fails.**

- [ ] **Step 1: Full build**

```bash
cd web && npm run build
```
PASS expected.

- [ ] **Step 2: New files present**

```bash
ls web/src/store/focusStore.ts
ls web/src/components/SessionFocus/
```
Expected: focusStore.ts + SessionFocus dir with SessionFocus.tsx, FocusSubbar.tsx, FocusTabs.tsx, SessionFocus.css, index.ts.

- [ ] **Step 3: Modifications landed**

```bash
grep -n "openFocus" web/src/store/dispatchStore.ts
grep -n "hideTabs\|onModeChange" web/src/SessionViewer.tsx
grep -n "SessionFocus" web/src/main.tsx
grep -n "focus-btn\|openFocus" web/src/dock/TerminalDockTab.tsx
grep -n "useFocusStore\|focusOpen" web/src/design/useGlobalShortcuts.ts
grep -n "Focus session\|openFocus" web/src/components/CommandPalette/CommandPalette.tsx
grep -n "session-focus" web/src/mobile.css
```
All should return at least one match.

- [ ] **Step 4: Backend test baseline (no NEW M2.5 failures)**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npx vitest run --pool=forks 2>&1 | tail -20
```
Expected: same baseline (15 pre-existing reply-hub failures only). No new failures.

- [ ] **Step 5: Smoke dev server**

```bash
cd web && npm run dev  # background
sleep 2
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
pkill -f vite || true
```

- [ ] **Step 6: Tag M2.5**

```bash
git tag ui-overhaul-m2.5
git tag --list 'ui-overhaul*'
```

- [ ] **Step 7: Manual walkthrough — DEFERRED to user**

1. Open the app, start an AI session on any todo (right-side dock shows session)
2. Click the new ⇆ button on the dock tab → Focus Mode overlay appears
3. Sub-bar shows: ← Grid btn / quadrant dot + title + #shortid / claude · running pill / ✕ close btn
4. Tab switcher: Conversation / Live 终端
5. Click Conversation → renders TranscriptView (turns + tool calls)
6. Click Live 终端 → renders xterm raw output
7. Tab switching preserves xterm state (no scrollback loss)
8. Press ⌘K → palette opens; type to search; switch to "Focus session" group; pick a session → focus opens for that session
9. Press Esc inside Focus Mode → focus closes (NOT palette, NOT drawer)
10. Press Esc with no focus + palette open → palette closes
11. ⇆ button only present on docked sessions (not on idle todos)
12. Mobile (resize narrow): Focus Mode covers full viewport (no 52px gap at top); sub-bar ID hidden
13. Theme switch (light/dark) inside Focus Mode → all chrome flips
14. dnd-kit drag still works on the grid (focus mode doesn't intercept events when closed)

- [ ] **Step 8: Final verdict**

If steps 1-6 all pass: ✅ M2.5 GATE PASSED. Else: ❌ list what blocks.

---

## Out of scope for M2.5 (lands in M3/M4)

- Real "Log 日志" raw-text tab (would need backend log API)
- Hero TodoCard click → Focus Mode (M3 — TodoCard rebuild)
- Conversation rendering rewrite to mockup style (turn marker visual + tool-call cards) — current TranscriptView styling stays
- Status line + Input redesign (currently inside AiTerminalMini's chrome — leave as-is for MVP)
- Session search inside Focus
- Multiple concurrent focused sessions (split view)
- Pull-to-refresh on mobile

## Risks (M2.5-specific)

| Risk | Mitigation |
|---|---|
| SessionViewer's `display: none/flex` tab switching is fragile when tab control moves to external | T3 keeps existing internal state as fallback; controlled mode only activates with `hideTabs` prop |
| AiTerminalMini's footer (status line + input) renders inside its body — Focus Mode doesn't add a separate footer | MVP: AiTerminalMini chrome stays; M3 may extract |
| ⇆ button placement on TerminalDockTab may conflict with existing tab close button | T8 step 1 reads file; if conflict, place button next to close (not over it) |
| Focus Mode overlay z-index conflicts with existing dock | z=80 sits above dock (which is < 80 likely); cmdk overlay (z=200) sits above focus — stacking order: dock < focus < palette |
| `quadrant` field may not exist on SessionMeta directly | T5 step 3 check; fallback to neutral color if missing |
| Mobile + xterm in Focus Mode may need viewport meta tweaks | T11 covers basics; full mobile QA is M4 |

## Acceptance criteria

| Criterion | Pass criterion | Verification |
|---|---|---|
| focusStore exists | `web/src/store/focusStore.ts` present | T1 |
| openFocus action | dispatchStore has openFocus that activates focusStore | T2 |
| SessionViewer tab control external | `hideTabs` + `mode` props work | T3 |
| Focus overlay renders | When focusedTodoId set, full-screen overlay shows | T4-7 |
| ⇆ button triggers focus | Click on TerminalDockTab → focus opens | T8 |
| Esc priority | Focus open → Esc closes focus before palette | T9 |
| Palette has Focus entries | "Focus session" group with one item per active session | T10 |
| Mobile usable | Overlay full-screen on narrow viewport | T11 |
| Build clean | npm run build PASS | T12 |
| Backend tests baseline | No new failures | T12 |
| Tag set | ui-overhaul-m2.5 | T12 |

---

## After M2.5

Write the M3 plan: `docs/superpowers/plans/2026-05-12-ui-overhaul-m3-hero-card-board.md`. M3 will reorganize TodoCard rendering and may decide to:
- Click on TodoCard → enter Focus Mode (using openFocus from dispatchStore)
- Move 找回 / Telegram / 模板 from second toolbar into TopbarDispatch or ⌘K
- Extract QuadrantBoard from TodoManage.tsx
- Cut TodoManage.tsx file size
- Polish Conversation rendering style to match mockup (turn markers + tool-call cards)
