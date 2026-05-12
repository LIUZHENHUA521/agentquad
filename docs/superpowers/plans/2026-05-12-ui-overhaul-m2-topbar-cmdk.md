# UI Overhaul — M2: Topbar Dispatch + ⌘K Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing inline topbar in `TodoManage.tsx` with a dedicated `TopbarDispatch` component (live status pills + drawer entries + theme toggle), and add a global `⌘K` command palette covering: create todo, navigate quadrants, search/jump-to todo, open drawers, start AI session (with todo picker), toggle theme.

**Architecture:**
- **State:** lift the 4 drawer-open booleans (`settingsOpen` / `statsOpen` / `wikiOpen` / `reportOpen`) plus a new `paletteOpen` into a single `dispatchStore` (zustand). Existing `aiSessionStore` provides session counts; existing `drawerStackStore` continues to manage z-stacking.
- **Components:** `StatPill` (presentational, with hover tooltip slot), `TopbarDispatch` (composes 3 pills + drawer buttons + ThemeToggle + ⌘K trigger), `CommandPalette` (uses `cmdk` library for keyboard nav + virtual focus, internal pages for "Start AI session" two-step flow).
- **Wiring:** TopbarDispatch + CommandPalette both read from `dispatchStore` + `aiSessionStore` directly (no prop drilling). TodoManage stops owning topbar JSX entirely.

**Tech Stack:** React 18 + TS + zustand 5 + AntD 5 + new dep `cmdk`. Builds on M1's design tokens + ThemeProvider.

**Spec reference:** `docs/superpowers/specs/2026-05-12-ui-overhaul-ai-first-design.md` § M2
**Visual reference:** `mockups/ui-overhaul-preview.html` (right-corner "M2 Demo" panel demos all 3 cmdk states + topbar pill tooltips)
**Builds on:** `docs/superpowers/plans/2026-05-12-ui-overhaul-m1-design-tokens.md` (M1 done, tagged `ui-overhaul-m1`)

---

## Resolved decisions (from brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | CommandPalette library | **`cmdk`** (handles keyboard nav + virtual focus + "pages" for sub-flows) |
| 2 | "Start AI session" context | **(a) Two-step picker**: pick tool → pick todo (matches mockup) |
| 3 | Topbar data source | **(a) zustand store** (`dispatchStore` for drawer state, `aiSessionStore` for counts — both already proven patterns) |
| 4 | Mobile topbar | **NOT in M2** — keep existing `MobileMenuOpen` drawer untouched; M4 will revisit |
| 5 | Remove temporary ThemeToggle mount in TodoManage | **Yes** (T11) |

---

## File Structure

**New files:**
- `web/src/store/dispatchStore.ts` — zustand store for: `paletteOpen`, `settingsOpen`, `statsOpen`, `wikiOpen`, `reportOpen`, plus setters + convenience `openDrawer(name)`
- `web/src/design/useDispatchStats.ts` — hook deriving active count / pending count / token sum from `aiSessionStore` + (placeholder) token source
- `web/src/design/useGlobalShortcuts.ts` — listens for `⌘K` / `Ctrl+K` and toggles `paletteOpen`; mounted once in `main.tsx`
- `web/src/components/StatPill/StatPill.tsx` — presentational pill (props: variant, dot/arrow icon, value, label, optional tooltip slot, click handler)
- `web/src/components/StatPill/StatPill.css`
- `web/src/components/StatPill/index.ts`
- `web/src/components/TopbarDispatch/TopbarDispatch.tsx` — composes logo + 3 pills + ⌘K btn + drawer btns + ThemeToggle
- `web/src/components/TopbarDispatch/TopbarDispatch.css`
- `web/src/components/TopbarDispatch/index.ts`
- `web/src/components/CommandPalette/CommandPalette.tsx` — `cmdk` wrapper, default + filtered + ai-picker "pages"
- `web/src/components/CommandPalette/CommandPalette.css`
- `web/src/components/CommandPalette/index.ts`

**Modified files:**
- `web/src/main.tsx` — mount `<CommandPalette />` after `<TodoManage />` inside `<AntdApp>`; mount `useGlobalShortcuts()` (call from inside `ThemedApp` body)
- `web/src/TodoManage.tsx` — REMOVE the inline topbar JSX + the 4 `useState(false)` drawer booleans + the temporary `<ThemeToggle />` mount; subscribe drawer-open from `useDispatchStore` instead; render `<TopbarDispatch />` where the topbar used to be
- `web/package.json` — add `cmdk@^1.0.0`

**Files we do NOT touch in M2:** TodoCard appearance (M3), QuadrantBoard structure (M3), AI terminal (M3/M4), drawer consolidation (M4), mobile topbar (M4).

---

## Conventions for this milestone

- Each pill / palette item has a stable `data-testid` so future tests can hook in (M2 doesn't add tests; this is for later).
- Hover tooltip for pills uses CSS-only (matches mockup) — no AntD `Tooltip` (avoids portal/positioning churn for short content).
- All keyboard shortcuts go through `useGlobalShortcuts` — don't sprinkle `keydown` listeners across components.
- The `dispatchStore.openPalette()` / `closePalette()` setters MUST be the only way to toggle the palette (no `setPaletteOpen(true)` from random places).
- One commit per task. Use `feat(topbar):` / `feat(cmdk):` / `refactor(state):` / `chore(deps):` prefixes.

---

## Task 1: Install cmdk + scaffold component dirs

**Files:**
- Modify: `web/package.json` (add cmdk)
- Create empty placeholders: `web/src/components/StatPill/.gitkeep`, `web/src/components/TopbarDispatch/.gitkeep`, `web/src/components/CommandPalette/.gitkeep`

- [ ] **Step 1: Install cmdk**

```bash
cd web && npm install cmdk@^1.0.0
```

Expected: package added, no errors.

- [ ] **Step 2: Create the component directories**

```bash
mkdir -p web/src/components/StatPill web/src/components/TopbarDispatch web/src/components/CommandPalette
touch web/src/components/StatPill/.gitkeep web/src/components/TopbarDispatch/.gitkeep web/src/components/CommandPalette/.gitkeep
```

- [ ] **Step 3: Verify build**

```bash
cd web && npm run build
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/package.json web/package-lock.json web/src/components/StatPill/.gitkeep web/src/components/TopbarDispatch/.gitkeep web/src/components/CommandPalette/.gitkeep
git commit -m "chore(deps): add cmdk for command palette + scaffold component dirs"
```

---

## Task 2: Build dispatchStore (zustand)

**Files:**
- Create: `web/src/store/dispatchStore.ts`

- [ ] **Step 1: Write dispatchStore.ts**

```ts
import { create } from 'zustand'

export type DrawerKey = 'settings' | 'stats' | 'wiki' | 'report'

interface DispatchState {
  // Drawer open flags (lifted from TodoManage local state)
  settings: boolean
  stats: boolean
  wiki: boolean
  report: boolean

  // Command palette open state
  palette: boolean

  // Action: open a drawer by name
  openDrawer: (key: DrawerKey) => void
  // Action: close a drawer by name
  closeDrawer: (key: DrawerKey) => void
  // Convenience: close every drawer at once (used when opening palette)
  closeAllDrawers: () => void

  // Palette controls
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
}

export const useDispatchStore = create<DispatchState>((set) => ({
  settings: false,
  stats: false,
  wiki: false,
  report: false,
  palette: false,

  openDrawer: (key) => set((s) => ({ ...s, [key]: true, palette: false })),
  closeDrawer: (key) => set(() => ({ [key]: false } as Partial<DispatchState>)),
  closeAllDrawers: () => set(() => ({ settings: false, stats: false, wiki: false, report: false })),

  openPalette: () => set(() => ({ palette: true })),
  closePalette: () => set(() => ({ palette: false })),
  togglePalette: () => set((s) => ({ palette: !s.palette })),
}))
```

- [ ] **Step 2: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/store/dispatchStore.ts
git commit -m "feat(state): add dispatchStore for drawer + palette open state"
```

---

## Task 3: Build useDispatchStats hook (live counts)

**Files:**
- Create: `web/src/design/useDispatchStats.ts`

This hook provides the data the topbar pills display.

- [ ] **Step 1: Inspect existing aiSessionStore to understand SessionMeta shape**

```bash
cat web/src/store/aiSessionStore.ts
```

Find the `SessionMeta` / `LiveSession` type. Key fields you'll need:
- `status` — likely `'running'` / `'thinking'` / `'pending_confirm'` / `'idle'` / etc.
- session ID

If the actual field names differ from above, adjust the code in step 2 to match.

- [ ] **Step 2: Write useDispatchStats.ts**

```ts
import { useMemo } from 'react'
import { useAiSessionStore } from '../store/aiSessionStore'

export interface DispatchStats {
  /** Sessions currently running OR thinking */
  activeCount: number
  /** Sessions waiting for user confirmation */
  pendingCount: number
  /** Aggregate input + output tokens used today (rough estimate) */
  tokenSum: number
  /** Display string for tokenSum (e.g. "24.5k") */
  tokenSumLabel: string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'm'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

export function useDispatchStats(): DispatchStats {
  const sessions = useAiSessionStore((s) => s.sessions)

  return useMemo(() => {
    let activeCount = 0
    let pendingCount = 0
    let tokenSum = 0
    sessions.forEach((session) => {
      const status = (session as { status?: string }).status
      if (status === 'running' || status === 'thinking') activeCount += 1
      if (status === 'pending_confirm') pendingCount += 1
      // Token sum: try common fields; if none present, contributes 0.
      const tokens = (session as { totalTokens?: number; tokens?: number }).totalTokens
        ?? (session as { tokens?: number }).tokens
        ?? 0
      if (typeof tokens === 'number') tokenSum += tokens
    })
    return { activeCount, pendingCount, tokenSum, tokenSumLabel: formatTokens(tokenSum) }
  }, [sessions])
}
```

NOTE: the token field on `SessionMeta` may not exist — if so, this returns 0. That's acceptable for M2; M3+ will wire a richer source. The pill simply shows "0 tok" until then.

- [ ] **Step 3: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
git add web/src/design/useDispatchStats.ts
git commit -m "feat(state): add useDispatchStats hook (active/pending/tokens)"
```

---

## Task 4: Build useGlobalShortcuts hook (⌘K listener)

**Files:**
- Create: `web/src/design/useGlobalShortcuts.ts`

- [ ] **Step 1: Write useGlobalShortcuts.ts**

```ts
import { useEffect } from 'react'
import { useDispatchStore } from '../store/dispatchStore'

/**
 * Global keyboard shortcuts. MUST be mounted exactly once (call from main.tsx ThemedApp).
 *
 * Currently:
 * - ⌘K / Ctrl+K → toggle command palette
 * - Esc → close palette (if open)
 *
 * Future: 1-4 quadrant nav, N for new todo, etc. (those will be wired through
 * the palette's command list to keep one source of truth.)
 */
export function useGlobalShortcuts() {
  const togglePalette = useDispatchStore((s) => s.togglePalette)
  const closePalette = useDispatchStore((s) => s.closePalette)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K (avoid catching when user is typing in an input)
      const target = e.target as HTMLElement | null
      const isTypingInForm =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // Allow ⌘K even inside inputs — that's the standard pattern
        e.preventDefault()
        togglePalette()
        return
      }

      if (e.key === 'Escape' && !isTypingInForm) {
        closePalette()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePalette, closePalette])
}
```

- [ ] **Step 2: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/design/useGlobalShortcuts.ts
git commit -m "feat(cmdk): add useGlobalShortcuts hook for ⌘K listener"
```

---

## Task 5: Build StatPill component

**Files:**
- Create: `web/src/components/StatPill/StatPill.tsx`
- Create: `web/src/components/StatPill/StatPill.css`
- Create: `web/src/components/StatPill/index.ts`

Mirrors the mockup's pill style (mono numbers, optional pulse dot, hover tooltip).

- [ ] **Step 1: Write StatPill.tsx**

```tsx
import React from 'react'
import './StatPill.css'

export type PillVariant = 'default' | 'alert'

export interface StatPillProps {
  variant?: PillVariant
  /** Optional left-side icon: 'dot' (status), 'pulse-dot' (status with ring), 'arrow' */
  icon?: 'dot' | 'pulse-dot' | 'arrow'
  /** Color for the dot or arrow icon (CSS color or token var) */
  iconColor?: string
  /** Numeric or short-text value (rendered in mono) */
  value: React.ReactNode
  /** Plain text label after the value */
  label: string
  /** Optional tooltip content rendered on hover */
  tooltip?: React.ReactNode
  /** Click handler (e.g., jump to a related view) */
  onClick?: () => void
  /** Test hook */
  'data-testid'?: string
}

export function StatPill(props: StatPillProps) {
  const {
    variant = 'default',
    icon,
    iconColor,
    value,
    label,
    tooltip,
    onClick,
  } = props
  return (
    <div
      className={`stat-pill stat-pill-${variant}${onClick ? ' stat-pill-clickable' : ''}`}
      onClick={onClick}
      data-testid={props['data-testid']}
    >
      {icon === 'dot' && (
        <span className="stat-pill-dot" style={iconColor ? { background: iconColor } : undefined} />
      )}
      {icon === 'pulse-dot' && (
        <span className="stat-pill-dot stat-pill-dot-pulse" style={iconColor ? { background: iconColor } : undefined} />
      )}
      {icon === 'arrow' && (
        <span className="stat-pill-arrow" style={iconColor ? { color: iconColor } : undefined}>▲</span>
      )}
      <span className="stat-pill-value">{value}</span>
      <span className="stat-pill-label">{label}</span>
      {tooltip && <div className="stat-pill-tooltip">{tooltip}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Write StatPill.css**

```css
.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  position: relative;
  transition: border-color var(--motion-fast) var(--ease-standard);
}
.stat-pill-clickable { cursor: pointer; }
.stat-pill:hover { border-color: var(--border-default); }
.stat-pill-clickable:hover { border-color: var(--accent-electric); }

.stat-pill-alert {
  background: color-mix(in srgb, var(--ai-pending-confirm) 10%, transparent);
  border-color: color-mix(in srgb, var(--ai-pending-confirm) 30%, transparent);
  color: var(--ai-pending-confirm);
}

.stat-pill-value {
  color: var(--text-primary);
  font-weight: 600;
}
.stat-pill-alert .stat-pill-value { color: var(--ai-pending-confirm); }

.stat-pill-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--ai-running);
  position: relative;
  flex-shrink: 0;
}
.stat-pill-dot-pulse::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: inherit;
  opacity: 0.4;
  animation: stat-pill-pulse 2s ease-out infinite;
}
@keyframes stat-pill-pulse {
  0% { transform: scale(0.8); opacity: 0.6; }
  100% { transform: scale(2.2); opacity: 0; }
}

.stat-pill-arrow {
  color: var(--accent-electric);
  font-size: 10px;
}

.stat-pill-tooltip {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 240px;
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
  box-shadow: var(--shadow-floating);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
  z-index: 110;
}
.stat-pill:hover .stat-pill-tooltip {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}
```

- [ ] **Step 3: Write index.ts**

```ts
export { StatPill, type StatPillProps, type PillVariant } from './StatPill'
```

- [ ] **Step 4: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/StatPill/
git commit -m "feat(topbar): add StatPill presentational component"
```

---

## Task 6: Build TopbarDispatch component

**Files:**
- Create: `web/src/components/TopbarDispatch/TopbarDispatch.tsx`
- Create: `web/src/components/TopbarDispatch/TopbarDispatch.css`
- Create: `web/src/components/TopbarDispatch/index.ts`

Composes logo + 3 stat pills + drawer buttons + ⌘K trigger + ThemeToggle.

- [ ] **Step 1: Write TopbarDispatch.tsx**

```tsx
import { Tooltip } from 'antd'
import { StatPill } from '../StatPill'
import { ThemeToggle } from '../ThemeToggle'
import { useDispatchStore } from '../../store/dispatchStore'
import { useDispatchStats } from '../../design/useDispatchStats'
import { useAiSessionStore } from '../../store/aiSessionStore'
import './TopbarDispatch.css'

export function TopbarDispatch() {
  const { activeCount, pendingCount, tokenSumLabel } = useDispatchStats()
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const togglePalette = useDispatchStore((s) => s.togglePalette)

  // Build the active-sessions tooltip from live store data
  const sessions = useAiSessionStore((s) => s.sessions)
  const activeList: { id: string; title: string; tool: string; status: string }[] = []
  const pendingList: { id: string; title: string; tool: string }[] = []
  sessions.forEach((s) => {
    const status = (s as { status?: string }).status
    const title = (s as { title?: string }).title ?? '(untitled)'
    const tool = (s as { tool?: string }).tool ?? 'ai'
    const id = (s as { sessionId?: string; id?: string }).sessionId ?? (s as { id?: string }).id ?? ''
    if (status === 'running' || status === 'thinking') {
      activeList.push({ id, title, tool, status })
    }
    if (status === 'pending_confirm') {
      pendingList.push({ id, title, tool })
    }
  })

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
                  <span className="topbar-tooltip-dot" style={{ background: s.status === 'thinking' ? 'var(--ai-thinking)' : 'var(--ai-running)' }} />
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

      <StatPill
        variant={pendingCount > 0 ? 'alert' : 'default'}
        icon="pulse-dot"
        iconColor="var(--ai-pending-confirm)"
        value={pendingCount}
        label="pending"
        data-testid="stat-pending"
        tooltip={
          pendingList.length === 0 ? (
            <div className="topbar-tooltip-empty">No pending confirmations</div>
          ) : (
            <>
              <div className="topbar-tooltip-title">Pending confirm ({pendingList.length})</div>
              {pendingList.map((s) => (
                <div key={s.id} className="topbar-tooltip-row">
                  <span className="topbar-tooltip-dot" style={{ background: 'var(--ai-pending-confirm)' }} />
                  <span className="topbar-tooltip-name">{s.title}</span>
                  <span className="topbar-tooltip-meta">{s.tool}</span>
                </div>
              ))}
            </>
          )
        }
      />

      <div className="topbar-spacer" />

      <button className="topbar-cmdk-btn" onClick={togglePalette} data-testid="topbar-cmdk-btn">
        <span className="topbar-cmdk-prefix">⌘</span>
        <span>Search or run a command</span>
        <kbd>⌘K</kbd>
      </button>

      <Tooltip title="Stats &amp; Reports">
        <button className="topbar-icon-btn" onClick={() => openDrawer('report')} data-testid="topbar-stats-btn">📊</button>
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

- [ ] **Step 2: Write TopbarDispatch.css**

```css
.topbar-dispatch {
  height: 52px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 10px;
  position: sticky;
  top: 0;
  z-index: 100;
}

.topbar-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: var(--text-md);
  margin-right: 8px;
  color: var(--text-primary);
}
.topbar-logo-mark {
  width: 26px; height: 26px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--accent-electric) 0%, var(--q1) 100%);
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--surface-0);
  font-size: var(--text-sm);
  box-shadow: 0 0 14px var(--accent-electric-glow);
}

.topbar-spacer { flex: 1; }

.topbar-icon-btn {
  width: 32px; height: 32px;
  border-radius: var(--radius-md);
  background: transparent;
  border: 1px solid transparent;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--motion-fast) var(--ease-standard);
  font-size: var(--text-md);
}
.topbar-icon-btn:hover {
  background: var(--surface-2);
  color: var(--text-primary);
  border-color: var(--border-subtle);
}

.topbar-cmdk-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 32px;
  background: var(--surface-2);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: all var(--motion-fast) var(--ease-standard);
}
.topbar-cmdk-btn:hover {
  border-color: var(--accent-electric);
  color: var(--text-primary);
  box-shadow: 0 0 0 3px var(--accent-electric-soft);
}
.topbar-cmdk-prefix { color: var(--accent-electric); font-weight: 600; }
.topbar-cmdk-btn kbd {
  font-family: var(--font-mono);
  background: var(--surface-3);
  border: 1px solid var(--border-default);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

/* Pill tooltip internals (mirrors StatPill.css's container) */
.topbar-tooltip-title {
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: var(--text-xs);
  margin-bottom: 6px;
}
.topbar-tooltip-empty {
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.topbar-tooltip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.topbar-tooltip-dot {
  width: 6px; height: 6px; border-radius: 50%;
  flex-shrink: 0;
}
.topbar-tooltip-name {
  color: var(--text-primary);
  flex: 1;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.topbar-tooltip-meta {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
```

- [ ] **Step 3: Write index.ts**

```ts
export { TopbarDispatch } from './TopbarDispatch'
```

- [ ] **Step 4: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TopbarDispatch/
git commit -m "feat(topbar): add TopbarDispatch component (logo + pills + drawers + ⌘K btn)"
```

---

## Task 7: Build CommandPalette skeleton (cmdk + 3 pages)

**Files:**
- Create: `web/src/components/CommandPalette/CommandPalette.tsx`
- Create: `web/src/components/CommandPalette/CommandPalette.css`
- Create: `web/src/components/CommandPalette/index.ts`

Single component, internal state for which "page" (default | aiPicker), search via cmdk's built-in filter.

- [ ] **Step 1: Write CommandPalette.tsx (skeleton with all 3 pages, no real handlers yet)**

```tsx
import { useState, useEffect } from 'react'
import { Command } from 'cmdk'
import { useDispatchStore } from '../../store/dispatchStore'
import { useTheme } from '../../design/ThemeProvider'
import { useAiSessionStore } from '../../store/aiSessionStore'
import './CommandPalette.css'

type Page = 'default' | 'aiPicker'

export function CommandPalette() {
  const open = useDispatchStore((s) => s.palette)
  const closePalette = useDispatchStore((s) => s.closePalette)
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const { toggle: toggleTheme } = useTheme()

  const [page, setPage] = useState<Page>('default')
  const [aiTool, setAiTool] = useState<'claude' | 'codex'>('claude')
  const [search, setSearch] = useState('')

  // Reset to default page each time the palette opens
  useEffect(() => {
    if (open) {
      setPage('default')
      setSearch('')
    }
  }, [open])

  const sessions = useAiSessionStore((s) => s.sessions)
  // Build a quick list of todo titles → ids for jump-to-todo and ai-picker.
  // SessionMeta carries title + sessionId; for non-session todos we'll need todo data later (M3).
  const todos: { id: string; title: string; quad?: string; status?: string; tool?: string }[] = []
  sessions.forEach((s) => {
    const id = (s as { sessionId?: string; id?: string }).sessionId ?? (s as { id?: string }).id ?? ''
    const title = (s as { title?: string }).title ?? '(untitled)'
    const status = (s as { status?: string }).status
    const tool = (s as { tool?: string }).tool
    const quad = (s as { quadrant?: string }).quadrant
    if (id) todos.push({ id, title, status, tool, quad })
  })

  if (!open) return null

  return (
    <div className="cmdk-overlay" onClick={(e) => { if (e.target === e.currentTarget) closePalette() }}>
      <Command
        label="Command Palette"
        className="cmdk-root"
        shouldFilter={page === 'default'}
      >
        <div className="cmdk-input-wrap">
          <span className="cmdk-prefix">⌘</span>
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder={
              page === 'aiPicker'
                ? `Search a todo to start AI session (${aiTool})...`
                : 'Type a command or search a todo...'
            }
            autoFocus
          />
          <kbd>esc</kbd>
        </div>

        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">No results.</Command.Empty>

          {page === 'default' && (
            <>
              <Command.Group heading="Quick actions">
                <Command.Item onSelect={() => { /* T8 wires this */ closePalette() }}>
                  <span className="cmdk-icon">+</span>
                  <span>Create new todo</span>
                  <span className="cmdk-meta">N</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('claude'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>Start AI session (claude) →</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('codex'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>Start AI session (codex) →</span>
                </Command.Item>
              </Command.Group>

              {todos.length > 0 && (
                <Command.Group heading="Jump to todo">
                  {todos.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`todo ${t.title}`}
                      onSelect={() => { /* T8 wires jump */ closePalette() }}
                    >
                      <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>›</span>
                      <span>{t.title}</span>
                      {t.tool && <span className="cmdk-meta">{t.tool}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Drawers">
                <Command.Item onSelect={() => { openDrawer('report'); closePalette() }}>
                  <span className="cmdk-icon">📊</span>
                  <span>Open Stats &amp; Reports</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('wiki'); closePalette() }}>
                  <span className="cmdk-icon">📖</span>
                  <span>Open Wiki</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('settings'); closePalette() }}>
                  <span className="cmdk-icon">⚙</span>
                  <span>Open Settings</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('stats'); closePalette() }}>
                  <span className="cmdk-icon">📈</span>
                  <span>Open Stats</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading="System">
                <Command.Item onSelect={() => { toggleTheme(); closePalette() }}>
                  <span className="cmdk-icon">🌙</span>
                  <span>Toggle theme (dark / light)</span>
                </Command.Item>
              </Command.Group>
            </>
          )}

          {page === 'aiPicker' && (
            <>
              <div className="cmdk-back-row" onClick={() => setPage('default')}>
                <span style={{ color: 'var(--accent-electric)' }}>←</span>
                <span>Start AI session — pick a todo ({aiTool})</span>
              </div>
              {todos.length === 0 && (
                <div className="cmdk-empty">No todos available — create one first.</div>
              )}
              {todos.length > 0 && (
                <Command.Group heading="Recent / Active todos">
                  {todos.map((t) => (
                    <Command.Item
                      key={t.id}
                      value={`pickedo ${t.title}`}
                      onSelect={() => {
                        // T8 wires actual session start
                        closePalette()
                      }}
                    >
                      <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>›</span>
                      <span>{t.title}</span>
                      {t.status && <span className="cmdk-meta">{t.status}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </>
          )}
        </Command.List>
      </Command>
    </div>
  )
}
```

NOTE: `cmdk` v1 expects `<Command.Input>` to be controlled via `value`+`onValueChange`. The list filters by matching the `value` prop on `<Command.Item>`. We pass `value={\`todo ${t.title}\`}` so search "503" matches the todo titled "线上 503 错误排查".

- [ ] **Step 2: Write CommandPalette.css**

```css
.cmdk-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  z-index: 200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 100px;
  animation: cmdk-fade var(--motion-fast) var(--ease-standard);
}
@keyframes cmdk-fade { from { opacity: 0; } to { opacity: 1; } }

.cmdk-root {
  width: 580px;
  max-width: calc(100vw - 32px);
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-floating);
  overflow: hidden;
  animation: cmdk-pop var(--motion-normal) var(--ease-spring);
  display: flex;
  flex-direction: column;
}
@keyframes cmdk-pop {
  from { transform: translateY(-8px) scale(0.98); opacity: 0; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}

.cmdk-input-wrap {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 10px;
}
.cmdk-prefix { color: var(--accent-electric); font-weight: 600; }
.cmdk-input-wrap input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--text-md);
  outline: none;
}
.cmdk-input-wrap input::placeholder { color: var(--text-tertiary); }
.cmdk-input-wrap kbd {
  font-family: var(--font-mono);
  background: var(--surface-2);
  border: 1px solid var(--border-default);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.cmdk-list {
  max-height: 400px;
  overflow-y: auto;
  padding: 6px;
}
.cmdk-list [cmdk-group-heading] {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
  padding: 10px 10px 4px;
  font-weight: 600;
}
.cmdk-list [cmdk-item] {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--text-base);
  transition: background var(--motion-fast) var(--ease-standard);
}
.cmdk-list [cmdk-item][data-selected="true"],
.cmdk-list [cmdk-item]:hover {
  background: var(--accent-electric-soft);
  color: var(--text-primary);
}
.cmdk-icon {
  color: var(--accent-electric);
  width: 18px;
  text-align: center;
  font-family: var(--font-mono);
  font-weight: 600;
}
.cmdk-meta {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}
.cmdk-empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}
.cmdk-back-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 4px;
  cursor: pointer;
}
.cmdk-back-row:hover { color: var(--text-primary); }
```

- [ ] **Step 3: Write index.ts**

```ts
export { CommandPalette } from './CommandPalette'
```

- [ ] **Step 4: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS. If cmdk v1 type definitions complain, check that `cmdk` was installed at `^1.0.0` and run `cd web && npm install` to refresh `node_modules`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/CommandPalette/
git commit -m "feat(cmdk): add CommandPalette skeleton with default + ai-picker pages"
```

---

## Task 8: Wire CommandPalette todo-jump + create-todo handlers

**Files:**
- Modify: `web/src/components/CommandPalette/CommandPalette.tsx`
- Modify: `web/src/store/dispatchStore.ts` (add `jumpToTodoId` + `requestNewTodo` flags)

The palette currently has placeholder handlers for "Create new todo" and "Jump to todo". Wire them through dispatchStore so TodoManage can react.

- [ ] **Step 1: Extend dispatchStore.ts with jump + create-request signals**

In `web/src/store/dispatchStore.ts`, add to the interface:

```ts
  /** When set, TodoManage should scroll/focus this todo and clear the field */
  jumpToTodoId: string | null
  /** When true, TodoManage should open its new-todo drawer and clear the flag */
  requestNewTodo: boolean

  setJumpTo: (id: string | null) => void
  requestNewTodoOpen: () => void
  consumeRequestNewTodo: () => void
```

And add to the store body:

```ts
  jumpToTodoId: null,
  requestNewTodo: false,

  setJumpTo: (id) => set(() => ({ jumpToTodoId: id })),
  requestNewTodoOpen: () => set(() => ({ requestNewTodo: true })),
  consumeRequestNewTodo: () => set(() => ({ requestNewTodo: false })),
```

- [ ] **Step 2: Wire CommandPalette handlers**

In `web/src/components/CommandPalette/CommandPalette.tsx`:

- Replace the "Create new todo" `onSelect`:
  ```tsx
  onSelect={() => {
    useDispatchStore.getState().requestNewTodoOpen()
    closePalette()
  }}
  ```

- Replace the "Jump to todo" `onSelect`:
  ```tsx
  onSelect={() => {
    useDispatchStore.getState().setJumpTo(t.id)
    closePalette()
  }}
  ```

- Replace the AI-picker `onSelect`:
  ```tsx
  onSelect={() => {
    // For now, jumping to the todo + setting an intent flag is enough.
    // T9 (or M3) will add a session-start API.
    useDispatchStore.getState().setJumpTo(t.id)
    closePalette()
    // Console-log the intent so the user sees we have the data flow.
    // eslint-disable-next-line no-console
    console.info('[cmdk] start AI session intent:', { tool: aiTool, todoId: t.id })
  }}
  ```

NOTE: actual "start session" requires calling an existing API (likely `apiStartAiSession(todoId, tool)` if it exists). For M2 we surface the **intent** (jump + log). M3 will hook the real start. If you find an obvious existing API by grepping `web/src/api.ts` for `startSession` or similar, you may wire it — but prefer the intent-only approach if the API is non-trivial.

- [ ] **Step 3: Verify build**

```bash
cd web && npx tsc --noEmit
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/store/dispatchStore.ts web/src/components/CommandPalette/CommandPalette.tsx
git commit -m "feat(cmdk): wire create-todo + jump-to-todo signals via dispatchStore"
```

---

## Task 9: Replace TodoManage's inline topbar with TopbarDispatch

**Files:**
- Modify: `web/src/TodoManage.tsx`

This is the big refactor. Find the existing inline topbar (around lines 1700-1750), the 4 drawer-open useState declarations (lines 845-850), the temporary `<ThemeToggle />` mount (added in M1 T8), and the `useDrawerStack` calls for each. Lift drawer state to dispatchStore.

- [ ] **Step 1: Read the relevant TodoManage sections**

```bash
sed -n '840,900p' web/src/TodoManage.tsx     # see drawer state declarations
sed -n '1690,1755p' web/src/TodoManage.tsx   # see inline topbar JSX
sed -n '2410,2435p' web/src/TodoManage.tsx   # see drawer mount points
```

- [ ] **Step 2: Replace the 4 drawer useState declarations with dispatchStore selectors**

Find these 4 lines (around 845-850):
```ts
const [settingsOpen, setSettingsOpen] = useState(false)
const [statsOpen, setStatsOpen] = useState(false)
const [wikiOpen, setWikiOpen] = useState(false)
// (line 848 may be a different state, leave it)
const [reportOpen, setReportOpen] = useState(false)
```

Replace with:
```ts
const settingsOpen = useDispatchStore((s) => s.settings)
const statsOpen = useDispatchStore((s) => s.stats)
const wikiOpen = useDispatchStore((s) => s.wiki)
const reportOpen = useDispatchStore((s) => s.report)
const closeDrawer = useDispatchStore((s) => s.closeDrawer)
```

And add the import at the top of the file (with other store imports):
```ts
import { useDispatchStore } from './store/dispatchStore'
```

Now find every callsite that uses `setSettingsOpen(true)` etc. and replace with `useDispatchStore.getState().openDrawer('settings')` (etc.). Every `setSettingsOpen(false)` becomes `closeDrawer('settings')`.

There are about 10 callsites. Use `grep -n "setSettingsOpen\|setStatsOpen\|setWikiOpen\|setReportOpen" web/src/TodoManage.tsx` to find them all.

- [ ] **Step 3: Replace the inline topbar JSX with `<TopbarDispatch />`**

The inline topbar lives in the desktop branch around lines 1690-1750 (it's a flex row with logo + filter buttons + Settings button + ThemeToggle from M1). Find the outer container (likely a `<div className="todo-toolbar">` or similar — check the actual class).

Replace the entire desktop topbar block with a single line:

```tsx
<TopbarDispatch />
```

Add the import at the top of the file:
```ts
import { TopbarDispatch } from './components/TopbarDispatch'
```

REMOVE:
- The temporary `<ThemeToggle />` mount with the `{/* TODO(M2): move to TopbarDispatch */}` comment (M1 T8 added it)
- The import of `ThemeToggle` from `./components/ThemeToggle` IF it's no longer used elsewhere in TodoManage. Confirm via `grep "ThemeToggle" web/src/TodoManage.tsx` after the edit — it should be 0.

KEEP:
- The mobile branch topbar (the `MobileMenuOpen` / `setMobileMenuOpen` flow). M2 deliberately doesn't touch mobile.
- All drawer mount points at the bottom of the file (`<SettingsDrawer open={settingsOpen} ...>` etc.) — they still work because we lifted state, not removed it.

- [ ] **Step 4: Update `useDrawerStack` calls**

Around lines 891-894 the existing code is:
```ts
useDrawerStack('settings', settingsOpen, () => setSettingsOpen(false))
useDrawerStack('stats', statsOpen, () => setStatsOpen(false))
useDrawerStack('wiki', wikiOpen, () => setWikiOpen(false))
useDrawerStack('report', reportOpen, () => setReportOpen(false))
```

Update the close handlers to use the new store:
```ts
useDrawerStack('settings', settingsOpen, () => closeDrawer('settings'))
useDrawerStack('stats', statsOpen, () => closeDrawer('stats'))
useDrawerStack('wiki', wikiOpen, () => closeDrawer('wiki'))
useDrawerStack('report', reportOpen, () => closeDrawer('report'))
```

- [ ] **Step 5: Update drawer mount points (onClose handlers)**

Around lines 2416-2419:
```tsx
<SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
<StatsDrawer open={statsOpen} onClose={() => setStatsOpen(false)} />
<WikiDrawer open={wikiOpen} onClose={() => setWikiOpen(false)} />
<ReportDrawer open={reportOpen} onClose={() => setReportOpen(false)} />
```

Update to:
```tsx
<SettingsDrawer open={settingsOpen} onClose={() => closeDrawer('settings')} />
<StatsDrawer open={statsOpen} onClose={() => closeDrawer('stats')} />
<WikiDrawer open={wikiOpen} onClose={() => closeDrawer('wiki')} />
<ReportDrawer open={reportOpen} onClose={() => closeDrawer('report')} />
```

- [ ] **Step 6: React to dispatchStore signals (jump + new todo)**

Add a useEffect inside TodoManage that watches `jumpToTodoId` and `requestNewTodo`:

```tsx
const jumpToTodoId = useDispatchStore((s) => s.jumpToTodoId)
const setJumpTo = useDispatchStore((s) => s.setJumpTo)
const requestNewTodo = useDispatchStore((s) => s.requestNewTodo)
const consumeRequestNewTodo = useDispatchStore((s) => s.consumeRequestNewTodo)

useEffect(() => {
  if (!jumpToTodoId) return
  // Find the card and scroll into view.
  const el = document.querySelector(`[data-todo-id="${jumpToTodoId}"]`) as HTMLElement | null
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('todo-card-flash')
    window.setTimeout(() => el.classList.remove('todo-card-flash'), 1200)
  }
  setJumpTo(null)
}, [jumpToTodoId, setJumpTo])

useEffect(() => {
  if (!requestNewTodo) return
  // Reuse existing new-todo entry — TodoManage uses `setDrawerOpen(true)` for create.
  // Find the line that opens the create drawer and call its setter here.
  // If that local state is `setDrawerOpen`, call setDrawerOpen(true).
  setDrawerOpen(true)
  consumeRequestNewTodo()
}, [requestNewTodo, consumeRequestNewTodo])
```

NOTE: The `setDrawerOpen` in step 6 refers to the existing local state for the new-todo drawer (line 738). If the actual setter has a different name, adjust.

NOTE: For the jump effect to work, todo cards must have `data-todo-id={todo.id}` attribute. If they don't, add it as a small change in the TodoCard render. If you can't easily find where the cards render, leave the effect in place as-is — it's a no-op when no element matches, and M3 will reorganize cards anyway.

- [ ] **Step 7: Add a tiny CSS flash for `todo-card-flash`**

In `web/src/TodoManage.css`, add at the bottom:
```css
.todo-card-flash {
  animation: todo-card-flash 1.2s ease-out;
}
@keyframes todo-card-flash {
  0% { box-shadow: 0 0 0 2px var(--accent-electric); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
```

- [ ] **Step 8: Verify build + smoke test**

```bash
cd web && npx tsc --noEmit
cd web && npm run build
cd web && npm run dev  # background
sleep 2
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
pkill -f vite || true
```

If tsc fails because `setSettingsOpen` etc. references aren't all gone, grep for them and clean up:
```bash
grep -n "setSettingsOpen\|setStatsOpen\|setWikiOpen\|setReportOpen" web/src/TodoManage.tsx
```
Expected after cleanup: empty.

- [ ] **Step 9: Commit**

```bash
git add web/src/TodoManage.tsx web/src/TodoManage.css
git commit -m "refactor(state): lift drawer state to dispatchStore + mount TopbarDispatch"
```

---

## Task 10: Mount CommandPalette + global shortcut in main.tsx

**Files:**
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Update ThemedApp to mount palette + shortcuts**

Modify `ThemedApp` in `web/src/main.tsx` to:

```tsx
import { ThemeProvider, useTheme } from './design/ThemeProvider'
import { getAntdTheme } from './design/antd-theme'
import { useGlobalShortcuts } from './design/useGlobalShortcuts'
import { CommandPalette } from './components/CommandPalette'

// ...

function ThemedApp() {
  const { mode } = useTheme()
  useGlobalShortcuts()
  return (
    <ConfigProvider locale={zhCN} theme={getAntdTheme(mode)}>
      <AntdApp message={{ maxCount: 3 }}>
        <TodoManage />
        <CommandPalette />
      </AntdApp>
    </ConfigProvider>
  )
}
```

The `<CommandPalette />` is a sibling of `<TodoManage />` inside `<AntdApp>` so it can use AntD components if needed and floats over everything via its own fixed-position overlay.

- [ ] **Step 2: Verify build + smoke test**

```bash
cd web && npm run build
cd web && npm run dev  # background
sleep 2
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
pkill -f vite || true
```

- [ ] **Step 3: Commit**

```bash
git add web/src/main.tsx
git commit -m "feat(cmdk): mount CommandPalette + useGlobalShortcuts in ThemedApp"
```

---

## Task 11: Add data-todo-id attribute to TodoCard wrapper for jump support

**Files:**
- Modify: `web/src/TodoManage.tsx` (within `SortableTodoCard` or wherever each card is rendered)

This makes the "Jump to todo" effect from T9 step 6 actually work.

- [ ] **Step 1: Find where todo cards render**

```bash
grep -n "SortableTodoCard\|key={todo\." web/src/TodoManage.tsx | head -20
```

Locate the JSX that wraps each card. Likely `<SortableTodoCard>` or a `<div key={todo.id}>` outer wrapper.

- [ ] **Step 2: Add data attribute**

On the outermost rendered element of each todo card (the one that's a direct sortable item), add:

```tsx
data-todo-id={todo.id}
```

If the card is a forwarded ref component, you may need to forward the attribute. If that's complex, fall back to wrapping each card render with a `<div data-todo-id={todo.id}>` (lower-cost change).

- [ ] **Step 3: Verify**

```bash
cd web && npx tsc --noEmit
```

In a dev server smoke test, check that `document.querySelectorAll('[data-todo-id]')` returns elements (run via browser devtools — but since we can't open a browser here, just confirm the attribute is in the rendered HTML by viewing source or running `curl` and grepping).

- [ ] **Step 4: Commit**

```bash
git add web/src/TodoManage.tsx
git commit -m "feat(cmdk): add data-todo-id attribute to enable palette jump-to-todo"
```

---

## Task 12: M2 verification gate

**No code changes unless something fails.**

- [ ] **Step 1: TypeScript build clean**

```bash
cd web && npm run build
```
Expected: PASS, no errors.

- [ ] **Step 2: Confirm zero leftover references to old drawer setters**

```bash
grep -nE "setSettingsOpen|setStatsOpen|setWikiOpen|setReportOpen" web/src/
```
Expected: zero matches in `web/src/` (the new pattern uses `closeDrawer('settings')` etc.)

- [ ] **Step 3: Confirm zero stale ThemeToggle imports in TodoManage**

```bash
grep -n "ThemeToggle" web/src/TodoManage.tsx
```
Expected: zero matches (now lives inside TopbarDispatch).

- [ ] **Step 4: Confirm new components are mounted**

```bash
grep -n "TopbarDispatch\|CommandPalette\|useGlobalShortcuts" web/src/main.tsx web/src/TodoManage.tsx
```
Expected:
- `TopbarDispatch` referenced in TodoManage (the import + the `<TopbarDispatch />` mount)
- `CommandPalette` and `useGlobalShortcuts` referenced in main.tsx

- [ ] **Step 5: Backend tests still pass**

```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo
npx vitest run --pool=forks 2>&1 | tail -20
```
Expected: same baseline as M1 (pre-existing 15 failures in `test/reply-hub.test.ts`, no NEW failures).

- [ ] **Step 6: Smoke dev server**

```bash
cd web && npm run dev  # background
sleep 2
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173/
pkill -f vite || true
```
Expected: HTTP 200, killed cleanly.

- [ ] **Step 7: Commit history check**

```bash
git log --oneline ui-overhaul-m1..HEAD
```

Expected ~12 commits, one per M2 task.

- [ ] **Step 8: Tag M2**

ONLY if all prior steps pass:
```bash
git tag ui-overhaul-m2
```

- [ ] **Step 9: Manual walkthrough (deferred to user)**

Items the user must verify in a browser:

1. New topbar renders with logo + 3 stat pills + ⌘K btn + Stats/Wiki/Settings icons + ThemeToggle
2. Hover each stat pill → tooltip appears with details (active sessions list, etc.)
3. Click ⌘K btn or press ⌘K / Ctrl+K → palette opens with all sections
4. Type "503" or any todo title fragment → results filter (cmdk built-in)
5. Click "Open Settings" in palette → settings drawer opens, palette closes
6. Click "Toggle theme" in palette → theme flips, palette closes
7. Click "Start AI session (claude) →" → palette switches to picker page; click ← back
8. Pick a todo from picker → palette closes; check console.info shows the intent
9. Press Esc → palette closes
10. The old inline topbar is gone (no duplicate Settings/⚙ buttons)
11. The temporary 🌙 ThemeToggle from M1 is no longer floating — only the one inside TopbarDispatch
12. Theme switch (light/dark) still works (no regression from M1)
13. Drag-and-drop a card still works
14. Mobile branch topbar still works (resize window narrow; the existing mobile menu should be untouched)

## Final verdict

✅ M2 GATE PASSED (proceed to user manual walkthrough), or ❌ M2 GATE FAILED (specify what blocks).

---

## Acceptance criteria for M2 (from spec § M2)

| Criterion | Pass criterion | Verification |
|---|---|---|
| TopbarDispatch on screen | Renders logo + 3 pills + cmdk btn + drawer btns + ThemeToggle | Manual walkthrough #1 |
| Live data in pills | Active count + pending count update with session changes | Inspect store; counts visible in UI |
| Hover tooltips | Each pill shows tooltip with relevant details | Manual walkthrough #2 |
| ⌘K opens palette | Both ⌘K and Ctrl+K work; click on btn also works | Manual walkthrough #3 |
| Filter by typing | Typing matches command names + todo titles via cmdk | Manual walkthrough #4 |
| Open drawers via palette | All 4 drawers reachable from palette | Manual walkthrough #5 |
| Toggle theme via palette | "Toggle theme" item works | Manual walkthrough #6 |
| Start AI session sub-flow | 2-step picker (tool → todo); back button; intent surfaced | Manual walkthrough #7-8 |
| Esc closes palette | Esc when palette is open closes it | Manual walkthrough #9 |
| Old topbar removed | No duplicate Settings/etc. buttons; no floating ThemeToggle | Manual walkthrough #10-11 |
| Theme switch unbroken | M1 functionality intact | Manual walkthrough #12 |
| dnd-kit drag unbroken | Cards still draggable | Manual walkthrough #13 |
| Mobile untouched | Mobile menu works as before | Manual walkthrough #14 |

---

## Out of scope for M2 (lands in M3/M4)

- Hero TodoCard redesign (M3)
- QuadrantBoard extraction + TodoManage file split ≤ 400 lines (M3)
- AI terminal status bar + thinking animation (M3)
- Real "Start AI session" wiring (the actual API call) (M3)
- AI terminal split-view (M4)
- Drawer consolidation (Stats + Report → tabs) (M4)
- Mobile responsive pass for the new topbar (M4)
- A11y, i18n (out entirely)
- New backend fields (out entirely)
- Frontend unit tests (out entirely)

---

## Risk register (M2-specific)

| Risk | Mitigation |
|---|---|
| Lifting drawer state to dispatchStore breaks an existing trigger | Step 2 of T9 enumerates all callsites — final grep ensures zero leftover `setXxxOpen` |
| cmdk v1 type definitions don't match the inferred types from spec | T7 step 4 surfaces this; if it happens, pin to specific cmdk version that has the right types |
| Existing `useDrawerStack` z-stack interaction conflicts with palette being on top | Palette uses higher z-index (200) than drawers, and `dispatchStore.openDrawer` clears `palette: false` |
| Token field doesn't exist on SessionMeta → pill shows 0 | Acceptable for M2 (documented in T3 step 2 NOTE); M3 will wire richer source |
| `data-todo-id` attribute can't be added cleanly to existing card | Fallback in T11 step 2: wrap each card with a `<div data-todo-id>` |
| `useGlobalShortcuts` catches ⌘K when user is typing in input | Code handles input/textarea/contenteditable — we still trigger on inputs because that's the standard pattern (matches mockup, matches Linear/Raycast); `Escape` is suppressed only inside form fields |

---

## After M2

When all tasks are checked and verification passes, write the M3 plan: `docs/superpowers/plans/2026-05-12-ui-overhaul-m3-hero-card-board.md`.

Note: at this point we will also have learned whether the user-requested "AI session focus mode" (full-screen view per the focus-mode mockup) should be slotted in as an "M2.5" or merged into M3's TodoCard work. That decision pending end-of-M2 review.
