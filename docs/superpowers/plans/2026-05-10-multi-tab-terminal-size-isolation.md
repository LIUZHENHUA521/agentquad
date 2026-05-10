# Multi-Tab AI Terminal Size Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop background browser tabs from constraining the PTY size of a session shared with foreground tabs, by making each tab unregister its size on `visibilitychange: hidden` and re-register on `visible`.

**Architecture:** No new protocol or backend logic. The server already has `applyAggregatedResize` (min over all browsers' last-reported sizes) and a "non-positive size means unregister" branch in `handleBrowserMessage`. Front-end change: extend the existing `handleVisibilityChange` in `AiTerminalMini.tsx` to send a `{type:'resize', cols:0, rows:0}` when the page hides, and force a `doFit()` (after clearing `lastSentSizeRef`) when it becomes visible. A new `isHiddenRef` flag short-circuits all background fit/resize triggers (ResizeObserver, window resize, IntersectionObserver) so they never re-register a size while hidden.

**Tech Stack:** React + xterm.js (`@xterm/xterm`, `@xterm/addon-fit`), Vitest, Express + ws backend.

Spec: `docs/superpowers/specs/2026-05-10-multi-tab-terminal-size-isolation-design.md`

---

### Task 1: Backend regression test — unregister via 0/0 restores aggregated size

This test locks in the contract the front-end will rely on: when a tab sends `{cols:0, rows:0}`, its previously contributed size is removed from the aggregation and `pty.resize` is called using the remaining browsers' min.

**Files:**
- Modify: `test/ai-terminal.route.test.js` (append a new `it()` inside the existing `describe('routes/ai-terminal', ...)`, near the existing browser/broadcast tests around line 480)

- [ ] **Step 1: Read the existing test file head to confirm the test harness**

Read `test/ai-terminal.route.test.js` lines 1–60 (already verified during planning). The harness exposes `ctx.ait.addBrowser`, `ctx.ait.handleBrowserMessage`, and `ctx.pty.resizes` records.

- [ ] **Step 2: Add the new test**

Append the following test inside `describe('routes/ai-terminal', ...)`, just after the `'broadcastToSession sends to all ws browsers for that session'` test (≈ line 494):

```js
it('aggregated resize ignores tabs that unregister via cols=0/rows=0', async () => {
  const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
  const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
    .send({ todoId: todo.id, prompt: 'hi', tool: 'claude' })
  const sessionId = body.sessionId

  const wsA = { readyState: 1, OPEN: 1, send: () => {} }
  const wsB = { readyState: 1, OPEN: 1, send: () => {} }
  ctx.ait.addBrowser(sessionId, wsA)
  ctx.ait.addBrowser(sessionId, wsB)

  // Both tabs report sizes — min wins.
  ctx.ait.handleBrowserMessage(sessionId, { type: 'resize', cols: 200, rows: 50 }, wsA)
  ctx.ait.handleBrowserMessage(sessionId, { type: 'resize', cols: 90, rows: 30 }, wsB)

  // Last resize sent to PTY should be the min: cols=90, rows=30.
  const afterBoth = ctx.pty.resizes[ctx.pty.resizes.length - 1]
  expect(afterBoth).toMatchObject({ id: sessionId, cols: 90, rows: 30 })

  // wsB unregisters (simulating tab going to background).
  ctx.ait.handleBrowserMessage(sessionId, { type: 'resize', cols: 0, rows: 0 }, wsB)

  // Aggregation should now use only wsA → cols=200, rows=50.
  const afterUnreg = ctx.pty.resizes[ctx.pty.resizes.length - 1]
  expect(afterUnreg).toMatchObject({ id: sessionId, cols: 200, rows: 50 })

  // And the wsB internal size record must be gone, so future reattach starts clean.
  expect(wsB.__quadtodoSize).toBeUndefined()
})
```

- [ ] **Step 3: Run the new test in isolation**

Run: `npx vitest run test/ai-terminal.route.test.js -t "aggregated resize ignores tabs that unregister"`

Expected: PASS. (No backend code changes are required — this is a regression lock for the existing branch at `src/routes/ai-terminal.js:723-727`.)

- [ ] **Step 4: Run the full ai-terminal route test file to ensure no collateral break**

Run: `npx vitest run test/ai-terminal.route.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/ai-terminal.route.test.js
git commit -m "test(ai-terminal): lock in unregister-via-zero-size aggregation behavior"
```

---

### Task 2: Front-end — visibility-aware resize unregister

Extend the existing `handleVisibilityChange` in `AiTerminalMini.tsx` to:
1. On hide → cancel pending fits, send `{cols:0, rows:0}`, set an `isHiddenRef` flag.
2. On visible → clear flag + `lastSentSizeRef`, refit.
3. Make ResizeObserver, window resize, and IntersectionObserver short-circuit when `isHiddenRef.current === true` so they don't re-register a size while hidden.

**Files:**
- Modify: `web/src/AiTerminalMini.tsx` (around lines 110, 645–657, 681–702, 706–712)

- [ ] **Step 1: Add `isHiddenRef` declaration**

In `web/src/AiTerminalMini.tsx`, find the `pendingResizeRef` declaration (currently around line 112):

```tsx
  const pendingResizeRef = useRef<{ cols: number; rows: number; timer: ReturnType<typeof setTimeout> | null } | null>(null)
```

Immediately after it, add:

```tsx
  // 切到后台 tab 时置 true：阻止 ResizeObserver / window resize / IO 在后台继续 fit + 上报，
  // 避免后台 tab 的 cols 把同 session 的前台 tab 拖到窄宽（PTY 走 min 聚合）。
  const isHiddenRef = useRef<boolean>(typeof document !== 'undefined' ? document.hidden : false)
```

- [ ] **Step 2: Replace `handleVisibilityChange` with hide+show logic**

Find the current handler (around line 645):

```tsx
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return
      if (disposedRef.current || stopReconnectRef.current) return
      lastPongRef.current = Date.now()
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        forceReconnect('标签页切回，连接已断开')
      } else {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
      term.focus()
    }
```

Replace with:

```tsx
    function handleVisibilityChange() {
      if (disposedRef.current || stopReconnectRef.current) return
      const hidden = document.visibilityState !== 'visible'
      if (hidden) {
        // 同 session 多 tab 时，PTY 尺寸取所有连接的 min。后台 tab 不应继续约束尺寸：
        // 取消 pending fit，发 0/0 让后端 unregister 我们这一份，并屏蔽后续后台触发。
        isHiddenRef.current = true
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current)
          resizeTimerRef.current = null
        }
        if (refitTimerRef.current) {
          clearTimeout(refitTimerRef.current)
          refitTimerRef.current = null
        }
        if (pendingResizeRef.current?.timer) {
          clearTimeout(pendingResizeRef.current.timer)
        }
        pendingResizeRef.current = null
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: 0 }))
        }
        // 重置已发送记录，等可见时重新发当前真实尺寸（不会被去抖跳过）
        lastSentSizeRef.current = null
        return
      }
      // 切回前台
      isHiddenRef.current = false
      lastPongRef.current = Date.now()
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        forceReconnect('标签页切回，连接已断开')
      } else {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
      // 清掉 lastSent 后立即 refit，重新把当前 cols/rows 加回聚合
      lastSentSizeRef.current = null
      requestAnimationFrame(() => {
        requestAnimationFrame(() => doFit())
      })
      term.focus()
    }
```

- [ ] **Step 3: Short-circuit ResizeObserver while hidden**

Find the ResizeObserver block (around line 681):

```tsx
    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        requestAnimationFrame(() => doFit())
      }, RESIZE_DEBOUNCE_MS)
    })
```

Replace with:

```tsx
    const ro = new ResizeObserver(() => {
      if (isHiddenRef.current) return
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        if (isHiddenRef.current) return
        requestAnimationFrame(() => doFit())
      }, RESIZE_DEBOUNCE_MS)
    })
```

- [ ] **Step 4: Short-circuit IntersectionObserver while hidden**

Find the IntersectionObserver block (around line 692):

```tsx
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) {
          refitAttemptsRef.current = 0
          requestAnimationFrame(() => {
            requestAnimationFrame(() => doFit())
          })
        }
      }
    })
```

Replace with:

```tsx
    const io = new IntersectionObserver((entries) => {
      if (isHiddenRef.current) return
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) {
          refitAttemptsRef.current = 0
          requestAnimationFrame(() => {
            requestAnimationFrame(() => doFit())
          })
        }
      }
    })
```

- [ ] **Step 5: Short-circuit window resize while hidden**

Find the window resize handler (around line 706):

```tsx
    function handleWindowResize() {
      if (windowResizeTimer) clearTimeout(windowResizeTimer)
      windowResizeTimer = setTimeout(() => {
        windowResizeTimer = null
        requestAnimationFrame(() => doFit())
      }, RESIZE_DEBOUNCE_MS)
    }
```

Replace with:

```tsx
    function handleWindowResize() {
      if (isHiddenRef.current) return
      if (windowResizeTimer) clearTimeout(windowResizeTimer)
      windowResizeTimer = setTimeout(() => {
        windowResizeTimer = null
        if (isHiddenRef.current) return
        requestAnimationFrame(() => doFit())
      }, RESIZE_DEBOUNCE_MS)
    }
```

- [ ] **Step 6: Handle WS reconnect while hidden**

The WS `onopen` handler (around line 457–475) currently resets `lastSentSizeRef` and triggers `doFit`. If the tab is hidden when WS reconnects (e.g., heartbeat-based reconnect after suspend), `doFit` will run + send the real size, re-introducing background pollution.

Find the `onopen` block (around line 457):

```tsx
      ws.onopen = () => {
```

Locate the `requestAnimationFrame(() => doFit())` call inside it (around line 475) and wrap with the hidden check by replacing:

```tsx
        // WS 打开后走 doFit 统一管路：guards + 稳定性去抖，
        // ...
          requestAnimationFrame(() => doFit())
```

with:

```tsx
        // WS 打开后走 doFit 统一管路：guards + 稳定性去抖，
        // ...
          requestAnimationFrame(() => {
            if (isHiddenRef.current) {
              // 重连时仍处后台：只发 0/0 unregister，不上报真实尺寸
              const wsNow = wsRef.current
              if (wsNow && wsNow.readyState === WebSocket.OPEN) {
                wsNow.send(JSON.stringify({ type: 'resize', cols: 0, rows: 0 }))
              }
              return
            }
            doFit()
          })
```

(The exact existing `requestAnimationFrame(() => doFit())` line should be located by reading lines 470–478 before editing — wrap *that* call site, do not add a duplicate.)

- [ ] **Step 7: Type-check the front-end**

Run: `cd web && npx tsc --noEmit`

Expected: no new TypeScript errors. (`isHiddenRef` is `useRef<boolean>` — straightforward.)

- [ ] **Step 8: Commit front-end changes**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "fix(web): unregister terminal size while tab is hidden to stop multi-tab cols pollution"
```

---

### Task 3: Manual verification

Front-end interaction logic with xterm + visibility is impractical to unit-test (jsdom mocks of `document.visibilityState` plus xterm internals would dwarf the change itself). Verify by hand against the spec's acceptance scenarios.

**Files:** none (manual)

- [ ] **Step 1: Start the dev environment**

Run: `npm run dev`
Expected: server listening on configured port, web Vite dev server up. Note both URLs.

- [ ] **Step 2: Scenario 1 — wide foreground vs narrow background**

In Chrome:
1. Open quadtodo in tab A. Start an AI terminal session on a todo. Drag dock to a wide width (≥ 1400px window).
2. Duplicate tab to make tab B (same URL, same session). Resize the B window narrow (≤ 700px) so its terminal cols are clearly smaller.
3. Confirm both tabs visible in their windows briefly: PTY runs at the narrower cols (Claude's TUI border in tab A leaves padding on the right). This is the existing aggregated-min behavior — sanity check.
4. Click tab A's window so tab B's tab is no longer the active tab in its window (i.e., B is hidden by switching to a different tab in B's browser window).
5. In tab A, run a fresh prompt or `/clear` then prompt → Claude output should now span tab A's full width (PTY rescaled to A's cols).

Expected: tab A no longer constrained by B's old size.

- [ ] **Step 3: Scenario 2 — bring background tab back**

Continuing from scenario 1: switch back to tab B. Within ~500ms, PTY should resize to B's cols; tab A's terminal redraws once at that new width (single visible reflow, not a chattering loop).

- [ ] **Step 4: Scenario 3 — sole tab going background**

With only tab A open, switch to a different browser tab (any other site). Wait 5s. Switch back.

Expected:
- Server log shows no spurious `pty.resize` calls (or at most one at switch-back if cols changed).
- Terminal continues to show output normally; no garbled rendering.

- [ ] **Step 5: Scenario 4 — regression check on existing flows**

Verify these still behave as before:
- Drag dock width slider → terminal refits.
- Toggle dock collapse / expand → terminal refits on expand.
- Open a popout window for the session → popout still works (Portal-based; same xterm instance, no extra WS).
- Split mode (two sessions side-by-side in dock) → each session resizes independently to its pane.
- Mobile fullscreen overlay (resize browser to mobile width) → still fits.

- [ ] **Step 6: Scenario 5 — mobile / lock screen**

On a phone (or mobile device emulator), open quadtodo → start a session → lock the screen for ~10s → unlock.

Expected: terminal renders normally; WS reconnect (if it dropped) succeeds; PTY size returns to current container cols. No "Claude drawing at 0 cols" garbled state.

- [ ] **Step 7: Note any deviations**

If any scenario fails, do **not** mark this task complete. File the failure mode (which scenario, observed vs expected, browser + OS), then return to Task 2 to debug.

- [ ] **Step 8: Commit verification note** (optional)

If the manual run uncovered minor copy / log tweaks, bundle them in a final commit:

```bash
git add -p
git commit -m "fix(web): minor follow-ups from multi-tab visibility test"
```

Otherwise skip — Task 2's commit already ships the fix.

---

## Self-Review

**Spec coverage:**
- Spec §"协议层" (use existing 0/0 unregister branch) → Task 1 verifies, Task 2 sends. ✓
- Spec §"前端改动" (visibilitychange hide/show, isHiddenRef gating, WS reconnect path) → Task 2 steps 1–6. ✓
- Spec §"后端改动" (no change, sanity-check `isValidResizeSize(0,0)` returns false) → confirmed during planning (`MIN_RESIZE_COLS=30`); Task 1's test is the live assertion. ✓
- Spec §"关键边界" (sole hidden tab, both foreground, reload during hidden, WS not connected) → Task 2 step 6 covers reconnect; Task 3 step 4 covers sole-hidden. ✓
- Spec §"验收标准" 1–5 → Task 3 steps 2–6 map 1:1. ✓
- Spec §"风险与缓解" iOS Safari note → mobile scenario in Task 3 step 6 exercises it; if it fails, the spec allows adding `pageshow` as a follow-up. The plan keeps that out of scope per the user's "先只做 visibilitychange" answer.

**Placeholder scan:** No "TODO", "TBD", or "fill-in" left. Each step shows the actual code and the exact command.

**Type consistency:** `isHiddenRef` is `useRef<boolean>` everywhere it's referenced. Resize message shape `{type:'resize', cols, rows}` matches the existing protocol used in `scheduleResizeSend`. `lastSentSizeRef` and `pendingResizeRef` references all match existing names in the file (verified by grep during planning).

**One known dependency:** Task 2 step 6 wraps an existing line in `ws.onopen`; the engineer must read lines 470–478 before editing to locate the exact `requestAnimationFrame(() => doFit())` call. Step 6 explicitly says so.
