# AI Terminal Defer-Init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `AiTerminalMini` 在默认 conversation tab（`display:none` 容器）里挂载时 fit 测出 0 宽度、按 80 cols 钉死 PTY 导致 claude/codex 输出窄列的 bug。

**Architecture:** 前端：容器不可量度时不调 `term.open()`，改用「祖先宽度 + JBM 字符宽测量」算出 proposed cols，先发 init 让后端 spawn PTY；中间 replay/output 暂存到 ref；IO 真正可见时再 term.open + flush + 校准 resize。后端：spawn fallback timer 5s → 30s。

**Tech Stack:** React 18, TypeScript, xterm.js v5 + addon-fit, vitest (jsdom), Node Express + ws + node-pty.

**Spec:** `docs/superpowers/specs/2026-05-15-ai-terminal-defer-init-until-fittable-design.md`

---

## File Structure

**Modify:**
- `src/routes/ai-terminal.js` — 5s → 30s fallback + 注释
- `web/src/AiTerminalMini.tsx` — 主要改造点
  - `waitTerminalReady` 返回 `{ visibleAndReady: boolean }`
  - 新增 module-level helper `measureCharWidth()` + `proposeColsFromAncestor()`
  - 新增 refs：`pendingChunksRef`、`pendingProposedInitRef`、`termOpenedRef`
  - 主 effect IIFE 拆出 hidden-mount 分支
  - WS `onmessage` 在 term 未 open 时把 output/replay 暂存到 ref
  - IO 首次 isIntersecting 时补 `term.open` + flush + 校准 resize
  - `session_restarted` 重置 pending refs

**Create:**
- `test/ai-terminal-defer-init.test.ts` — 4 个核心时序测试（jsdom + 显式 mock xterm.js）
- `test/xterm-write-before-open.probe.test.ts` — 探针：确认 xterm.js 支持 write/dispose 在 open 前

**Constants（加在 AiTerminalMini.tsx 模块顶部，靠近 `MIN_CONTAINER_WIDTH`）：**
```ts
const PENDING_CHUNKS_CAP = 5 * 1024 * 1024  // 5 MB
const PROPOSED_CHAR_WIDTH_FALLBACK = 7.8     // JBM 13px 经验值
const PROPOSED_BORDER_PX = 2                 // wrapper 1px×2
const PROPOSED_XTERM_PADDING_PX = 14         // xterm 内部 padding 估算
const PROPOSED_TOOLBAR_PX = 60               // toolbar + 拖拽手柄
const PROPOSED_LINE_HEIGHT_PX = 18           // 13px JBM 经验行高
const MIN_PROPOSED_WIDTH = 280               // 确保除法不出负值
```

---

## Task 0: Probe — xterm.js write/dispose before open

**Files:**
- Test: `test/xterm-write-before-open.probe.test.ts`

- [ ] **Step 1: Write探针测试**

```ts
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'

describe('xterm.js v5 — pre-open API behavior', () => {
  it('Terminal.write before open does not throw', () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    expect(() => term.write('hello world\r\n')).not.toThrow()
    term.dispose()
  })

  it('Terminal.dispose before open does not throw', () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    expect(() => term.dispose()).not.toThrow()
  })

  it('writes buffered before open are visible after open', async () => {
    const term = new Terminal({ cols: 80, rows: 24 })
    term.write('foo\r\n')
    const div = document.createElement('div')
    Object.defineProperty(div, 'clientWidth', { value: 800 })
    Object.defineProperty(div, 'clientHeight', { value: 600 })
    document.body.appendChild(div)
    term.open(div)
    // xterm.js 默认 async write —— 用 callback 等 drain
    await new Promise<void>(r => term.write('', () => r()))
    const line = term.buffer.active.getLine(0)
    expect(line?.translateToString(true).startsWith('foo')).toBe(true)
    term.dispose()
    div.remove()
  })
})
```

- [ ] **Step 2: 跑探针**

Run: `npx vitest run test/xterm-write-before-open.probe.test.ts -t "pre-open"`
Expected: 3 个 case 全 PASS。如果第三个失败（buffer 在 open 之前不接受 write），则 plan 退回到「纯 pendingChunksRef」路径——记 `pendingChunksRef.push(chunk)` 而不是 `term.write`，下个任务实现以此为准。

- [ ] **Step 3: 提交**

```bash
git add test/xterm-write-before-open.probe.test.ts
git commit -m "test: probe xterm.js v5 write/dispose behavior before open"
```

---

## Task 1: Backend — spawnFallbackTimer 5s → 30s

**Files:**
- Modify: `src/routes/ai-terminal.js:666` (the setTimeout in `spawnSession`)

- [ ] **Step 1: 改 timer 时长**

替换 `src/routes/ai-terminal.js:664-676`：

```js
// 4. 30s 兜底：前端如果一直没发合法 init（极少见 — 旧版本前端 / 网络真的挂了），
// 用老的 80×24 兜底 spawn，避免 session 永远卡在 create 状态。
// 30s（不是 5s）的理由：新前端在隐藏挂载时会延迟到 IO 可见才发 init，主人停留在
// conversation tab 默认体验里也不应该撞兜底；30s 既给足切换窗口、又保留挂掉时的退路。
session.spawnFallbackTimer = setTimeout(() => {
  session.spawnFallbackTimer = null
  if (session.spawned) return
  console.warn(`[ai-terminal] spawn fallback fired session=${sessionId} (no init within 30s)`)
  session.spawned = true
  pty.startWithSize(sessionId, 80, 24).catch((e) => {
    console.warn(`[ai-terminal] spawn fallback failed: ${e.message}`)
    session.spawned = false
  })
}, 30000)
session.spawnFallbackTimer.unref?.()
```

- [ ] **Step 2: 跑现有 backend 测试**

Run: `npx vitest run test/ai-terminal.route.test.js test/ai-terminal.effective-status.test.js test/ai-terminal-orphan-sweep.test.js test/ai-terminal-scrollback-limit.test.js test/ai-terminal-first-switch-bottom.test.js`
Expected: 全 PASS（这条改 timer 只是数字，不影响逻辑）

- [ ] **Step 3: 提交**

```bash
git add src/routes/ai-terminal.js
git commit -m "fix(ai-terminal): extend spawn fallback timer 5s→30s

新前端在 conversation tab 默认体验下会延迟到 IO 可见再发 init，
5s 太短会让兜底用 80×24 spawn，把 PTY 钉死在窄 cols。"
```

---

## Task 2: Frontend utility — measureCharWidth

**Files:**
- Create: `web/src/utils/measureCharWidth.ts`
- Test: `test/measure-char-width.test.ts`

- [ ] **Step 1: 写失败测试**

`test/measure-char-width.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

describe('measureCharWidth', () => {
  it('returns fallback when document.fonts is unavailable', async () => {
    const { measureCharWidth } = await import('../web/src/utils/measureCharWidth.ts')
    // jsdom 没有 document.fonts —— 应该 fallback
    const w = await measureCharWidth()
    expect(w).toBeGreaterThan(0)
    // 7.8 ± 1
    expect(w).toBeLessThanOrEqual(10)
  })

  it('returns positive cached value on second call', async () => {
    const { measureCharWidth, _resetMeasureCharWidthCache } = await import('../web/src/utils/measureCharWidth.ts')
    _resetMeasureCharWidthCache()
    const w1 = await measureCharWidth()
    const w2 = await measureCharWidth()
    expect(w2).toBe(w1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/measure-char-width.test.ts`
Expected: FAIL `Cannot find module '../web/src/utils/measureCharWidth.ts'`

- [ ] **Step 3: 实现 measureCharWidth**

Create `web/src/utils/measureCharWidth.ts`:

```ts
const FALLBACK_PX = 7.8
const SAMPLE_COUNT = 100

let cached: number | null = null

export function _resetMeasureCharWidthCache(): void {
  cached = null
}

export async function measureCharWidth(): Promise<number> {
  if (cached !== null) return cached
  try {
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>(r => setTimeout(r, 500)),
      ])
    }
    if (typeof document === 'undefined' || !document.body) {
      cached = FALLBACK_PX
      return cached
    }
    const probe = document.createElement('span')
    probe.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'top:-9999px',
      'left:-9999px',
      'font:13px "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
      'white-space:pre',
      'padding:0',
      'border:0',
      'margin:0',
    ].join(';')
    probe.textContent = 'M'.repeat(SAMPLE_COUNT)
    document.body.appendChild(probe)
    const rect = probe.getBoundingClientRect()
    document.body.removeChild(probe)
    const w = rect.width > 0 ? rect.width / SAMPLE_COUNT : FALLBACK_PX
    cached = w
    return w
  } catch {
    cached = FALLBACK_PX
    return cached
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/measure-char-width.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/utils/measureCharWidth.ts test/measure-char-width.test.ts
git commit -m "feat(utils): add measureCharWidth helper for terminal cols proposal"
```

---

## Task 3: Frontend helper — proposeColsFromAncestor

**Files:**
- Modify: `web/src/AiTerminalMini.tsx` — 在 module 顶部新增 helper（紧挨 `waitTerminalReady`）
- Test: `test/propose-cols.test.ts`

- [ ] **Step 1: 写失败测试**

`test/propose-cols.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('proposeColsFromAncestor', () => {
  it('uses ancestor clientWidth when container has zero width', async () => {
    const { proposeColsFromAncestor } = await import('../web/src/AiTerminalMini.tsx')
    const ancestor = document.createElement('div')
    Object.defineProperty(ancestor, 'offsetParent', { value: document.body })
    Object.defineProperty(ancestor, 'clientWidth', { value: 1200 })
    Object.defineProperty(ancestor, 'clientHeight', { value: 800 })
    const inner = document.createElement('div')
    Object.defineProperty(inner, 'offsetParent', { value: null })
    Object.defineProperty(inner, 'clientWidth', { value: 0 })
    ancestor.appendChild(inner)
    document.body.appendChild(ancestor)
    const result = proposeColsFromAncestor(inner, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)
    expect(result!.rows).toBeGreaterThan(0)
    ancestor.remove()
  })

  it('clamps cols to MIN_VALID_COLS when ancestor is narrow', async () => {
    const { proposeColsFromAncestor } = await import('../web/src/AiTerminalMini.tsx')
    const ancestor = document.createElement('div')
    Object.defineProperty(ancestor, 'offsetParent', { value: document.body })
    Object.defineProperty(ancestor, 'clientWidth', { value: 320 })
    Object.defineProperty(ancestor, 'clientHeight', { value: 600 })
    document.body.appendChild(ancestor)
    const result = proposeColsFromAncestor(ancestor, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)
    ancestor.remove()
  })

  it('returns null when no ancestor has layout', async () => {
    const { proposeColsFromAncestor } = await import('../web/src/AiTerminalMini.tsx')
    const orphan = document.createElement('div')
    Object.defineProperty(orphan, 'offsetParent', { value: null })
    Object.defineProperty(orphan, 'clientWidth', { value: 0 })
    const result = proposeColsFromAncestor(orphan, 7.8)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run test/propose-cols.test.ts`
Expected: FAIL "proposeColsFromAncestor is not a function" 或类似

- [ ] **Step 3: 实现 helper + 常量**

在 `web/src/AiTerminalMini.tsx` 顶部（紧挨 `MIN_CONTAINER_WIDTH = 300` 那一组常量）追加：

```ts
const PENDING_CHUNKS_CAP = 5 * 1024 * 1024
const PROPOSED_CHAR_WIDTH_FALLBACK = 7.8
const PROPOSED_BORDER_PX = 2
const PROPOSED_XTERM_PADDING_PX = 14
const PROPOSED_TOOLBAR_PX = 60
const PROPOSED_LINE_HEIGHT_PX = 18
const MIN_PROPOSED_WIDTH = 280

export function proposeColsFromAncestor(
  container: HTMLElement,
  charWidth: number,
): { cols: number; rows: number } | null {
  let el: HTMLElement | null = container
  while (el) {
    if (el.offsetParent !== null && el.clientWidth >= MIN_CONTAINER_WIDTH) {
      const rawW = el.clientWidth - PROPOSED_BORDER_PX - PROPOSED_XTERM_PADDING_PX
      const availableW = Math.max(rawW, MIN_PROPOSED_WIDTH)
      const rawH = (el.clientHeight || window.innerHeight * 0.6) - PROPOSED_TOOLBAR_PX
      const availableH = Math.max(rawH, PROPOSED_LINE_HEIGHT_PX * 10)
      const cw = charWidth > 0 ? charWidth : PROPOSED_CHAR_WIDTH_FALLBACK
      const cols = Math.max(Math.floor(availableW / cw), MIN_VALID_COLS)
      const rows = Math.max(Math.floor(availableH / PROPOSED_LINE_HEIGHT_PX), 10)
      return { cols, rows }
    }
    el = el.parentElement
  }
  return null
}
```

注意：`MIN_CONTAINER_WIDTH` / `MIN_VALID_COLS` 已存在，复用不再定义。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run test/propose-cols.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: 提交**

```bash
git add web/src/AiTerminalMini.tsx test/propose-cols.test.ts
git commit -m "feat(AiTerminalMini): add proposeColsFromAncestor helper

为下一步『隐藏挂载时 proposed init』做准备 —— 容器测不出宽度时，
从祖先链拿真实尺寸 + 字符宽测量算出 cols/rows。"
```

---

## Task 4: Frontend — waitTerminalReady 返回 visibleAndReady

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:104-128` (waitTerminalReady 函数)
- Modify: `web/src/AiTerminalMini.tsx:444` (主 effect 调用处)

- [ ] **Step 1: 改函数签名 + 实现**

替换 `web/src/AiTerminalMini.tsx:104-128`（整个 `waitTerminalReady` 函数）：

```ts
// Wait until (a) the container has settled layout and is visible, AND
// (b) the bundled JetBrains Mono font is loaded.
// Returns visibleAndReady=true when the container met (a) before timeout;
// false means we timed out — caller must take the hidden-mount path
// (proposeColsFromAncestor + defer term.open).
async function waitTerminalReady(container: HTMLDivElement): Promise<{ visibleAndReady: boolean }> {
  const start = Date.now()
  const TIMEOUT_MS = 3000

  let visibleAndReady = false
  while (Date.now() - start < TIMEOUT_MS) {
    if (container.offsetParent !== null && container.clientWidth >= MIN_CONTAINER_WIDTH) {
      visibleAndReady = true
      break
    }
    await new Promise(r => setTimeout(r, 50))
  }

  try {
    await Promise.race([
      Promise.all([
        document.fonts.ready,
        (document.fonts as any).load?.('13px "JetBrains Mono"') ?? Promise.resolve(),
      ]),
      new Promise(r => setTimeout(r, Math.max(0, TIMEOUT_MS - (Date.now() - start)))),
    ])
  } catch { /* font API can throw on older Safari; ignore */ }

  await new Promise<void>(r => requestAnimationFrame(() => r()))
  return { visibleAndReady }
}
```

- [ ] **Step 2: 临时改调用处兼容**

`web/src/AiTerminalMini.tsx:444`：

```ts
const { visibleAndReady } = await waitTerminalReady(container)
// 标志位先存到一个 const，后面 Task 6 才会真正用到走分支
void visibleAndReady  // 暂时不分支，下一个任务会用
```

- [ ] **Step 3: 类型检查 + 现有测试全跑**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS（没有类型错误）

Run（在项目根目录）: `npx vitest run`
Expected: 全 PASS（行为完全没变）

- [ ] **Step 4: 提交**

```ts
git add web/src/AiTerminalMini.tsx
git commit -m "refactor(AiTerminalMini): waitTerminalReady returns visibleAndReady

为下一步『hidden-mount 走 proposed init 分支』做准备 —— 调用方需要
知道容器超时是否真的拿到了可量度的宽度。"
```

---

## Task 5: Frontend — refs for pendingChunks + termOpened + pendingProposedInit

**Files:**
- Modify: `web/src/AiTerminalMini.tsx` 主组件 body 顶部的 refs 区（紧挨 `lastSentSizeRef`）

- [ ] **Step 1: 加 refs**

在 `web/src/AiTerminalMini.tsx:195` 附近（`lastSentSizeRef` 那一组 ref 旁），插入：

```ts
// term.open 是否已经调用 —— hidden-mount 路径下推迟到 IO 可见
const termOpenedRef = useRef<boolean>(false)
// term 还没 open 期间，WS 收到的 output/replay chunks 暂存到这里
// 结构：{ chunks: 累计字符串数组, totalBytes: 字节累计 }，封顶 5MB，溢出丢头部
const pendingChunksRef = useRef<{ chunks: string[]; totalBytes: number }>({ chunks: [], totalBytes: 0 })
// 走 proposed init 时记下当时报的 cols/rows，IO 触发 fit 后若实测不同就发一次 resize 校准
const pendingProposedInitRef = useRef<{ cols: number; rows: number } | null>(null)
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS（refs 已定义但还未使用，TS 不会报 unused）

- [ ] **Step 3: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "refactor(AiTerminalMini): scaffold refs for hidden-mount defer path"
```

---

## Task 6: Frontend — 主 effect 拆分 visible 与 hidden-mount 路径

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:441-583` (主 effect IIFE 中 await waitTerminalReady 后的整段)

- [ ] **Step 1: 改写主 effect IIFE**

把 `web/src/AiTerminalMini.tsx:441-583`（从 `void (async () => {` 开始，到 `if (!viewportReadyRef.current ... )` 这块 reveal 逻辑之前）改写——核心是把现有「构造 term + open + fit」整体重排，hidden 时跳过 term.open + fit.fit，提前算 proposed cols：

```ts
void (async () => {
  const container = containerRef.current
  if (!container) return
  const { visibleAndReady } = await waitTerminalReady(container)
  if (disposedRef.current || myGen !== effectGenRef.current) return

  // 重置每次 effect 启动时的 hidden-mount 相关状态
  termOpenedRef.current = false
  pendingChunksRef.current = { chunks: [], totalBytes: 0 }
  pendingProposedInitRef.current = null

  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
    theme: themeRef.current,
    cursorBlink: false,
    convertEol: true,
    scrollback: 30000,
    disableStdin: false,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  termRef.current = term
  fitRef.current = fit

  if (visibleAndReady) {
    // 可见路径：原行为，term.open + fit 同步算出 cols
    term.open(container)
    termOpenedRef.current = true
    try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11' } catch {}
    try { term.loadAddon(new CanvasAddon()) } catch {}
    term.write('\x1b[?25l')
    setupImeAndKeyHandlers(term)  // 见下方说明
    setupLinkProvider(term)
    try { fit.fit() } catch (e) { console.warn('[AiTerminalMini] initial fit failed:', e) }
  } else {
    // 隐藏挂载路径：算 proposed cols，先发 init；term.open 推迟到 IO 触发
    const charWidth = await measureCharWidth().catch(() => PROPOSED_CHAR_WIDTH_FALLBACK)
    if (disposedRef.current || myGen !== effectGenRef.current) return
    const proposed = proposeColsFromAncestor(container, charWidth)
    if (proposed) {
      pendingProposedInitRef.current = proposed
      // 把 cols/rows 也喂给 term —— xterm.js Terminal 实例可以在 open 之前
      // 通过 cols/rows constructor option 接收尺寸；这里改用 resize() 让 fit 后续校准时不抖
      try { term.resize(proposed.cols, proposed.rows) } catch {}
    }
    // 注意：IME / Link / Unicode / Canvas addon 都依赖 term.textarea / term.element，
    // 这些在 open 之前不存在。延迟到 IO 触发的 term.open 之后做。
  }

  // Reveal 逻辑保留（visibleAndReady 才会满足条件）
  if (
    !viewportReadyRef.current
    && termOpenedRef.current
    && container.offsetParent !== null
    && container.clientWidth >= MIN_CONTAINER_WIDTH
    && term.cols >= MIN_VALID_COLS
  ) {
    viewportReadyRef.current = true
    const reveal = () => {
      if (!disposedRef.current && myGen === effectGenRef.current) setViewportReady(true)
    }
    try {
      term.write('', () => {
        try { term.scrollToBottom() } catch {}
        requestAnimationFrame(() => requestAnimationFrame(reveal))
      })
    } catch {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            reveal()
            setTimeout(reveal, 16)
          })))
    }
  }

  // ... connectWs() 调用维持在这里，下面紧接老代码
```

**重要：抽出两个 helper（在主组件函数里，不要 module-level）：**

把原来分散的 IME 监听 + 链接 provider 抽成两个本地函数 `setupImeAndKeyHandlers(term)` 和 `setupLinkProvider(term)`，把现有 482-546 行的代码原样搬进去（注意闭包要引用的 ref：`imeComposing` 改成 useRef 或者用 `let imeComposingRef = { current: false }` 这种）。

> 这一步代码量最大但纯属机械搬运。如果搬运过程让本任务体积爆炸，可以拆成 6a / 6b 两个连续提交。

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS

- [ ] **Step 3: 跑现有所有终端相关测试**

Run: `npx vitest run test/ai-terminal-recovery.test.ts test/ai-terminal-first-switch-bottom.test.js test/ai-terminal-orphan-sweep.test.js test/ai-terminal.effective-status.test.js test/ai-terminal.route.test.js test/ai-terminal-scrollback-limit.test.js test/measure-char-width.test.ts test/propose-cols.test.ts test/xterm-write-before-open.probe.test.ts`
Expected: 全 PASS

- [ ] **Step 4: 手测 visible 路径**

启动 dev：`npm run dev`（先看 README/cli.js）
新建一个 todo → 改默认 tab 为 live（临时改 `focusStore.ts:22` 为 `'live'`，验证后改回）→ 点 AI 执行 → 终端打开 → 应当像旧版一样正常。

- [ ] **Step 5: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "refactor(AiTerminalMini): split main effect into visible vs hidden-mount paths

hidden-mount 路径只构造 Terminal 实例 + 调 term.resize(proposed) —— 不 open，
也不 fit。term.open 延迟到 IO 触发，下一个提交把 WS 消息暂存接上。"
```

---

## Task 7: Frontend — WS 消息暂存到 pendingChunksRef（term 未 open 时）

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:682-693` (WS onmessage 的 `output` / `replay` case)

- [ ] **Step 1: 改写 output / replay 分支**

替换 `web/src/AiTerminalMini.tsx:682-693`：

```ts
case 'output':
  if (typeof msg.data === 'string' && msg.data.length > 0) {
    cancelInjectingHint()
    if (termOpenedRef.current) {
      term.write(stripCursorVisibility(msg.data))
    } else {
      bufferPendingChunk(stripCursorVisibility(msg.data))
    }
  }
  break
case 'replay':
  if (Array.isArray(msg.chunks)) {
    if (msg.chunks.length > 0) cancelInjectingHint()
    for (const chunk of msg.chunks) {
      const stripped = stripCursorVisibility(chunk)
      if (termOpenedRef.current) term.write(stripped)
      else bufferPendingChunk(stripped)
    }
    if (termOpenedRef.current) term.write('\x1b[0m')
    else bufferPendingChunk('\x1b[0m')
  }
  break
```

在主组件函数 body 内（refs 旁边）加 helper：

```ts
const bufferPendingChunk = useCallback((chunk: string) => {
  const buf = pendingChunksRef.current
  buf.chunks.push(chunk)
  buf.totalBytes += chunk.length
  if (buf.totalBytes > PENDING_CHUNKS_CAP) {
    // 溢出丢头部：把数组合并成单个字符串，截掉前面 totalBytes - CAP 字符
    const joined = buf.chunks.join('')
    const overflow = joined.length - PENDING_CHUNKS_CAP
    const trimmed = joined.slice(overflow)
    buf.chunks = [trimmed]
    buf.totalBytes = trimmed.length
    console.warn('[AiTerminalMini] pending chunks > 5MB, dropped head')
  }
}, [])

const flushPendingChunks = useCallback(() => {
  const term = termRef.current
  if (!term) return
  const buf = pendingChunksRef.current
  for (const chunk of buf.chunks) {
    try { term.write(chunk) } catch (e) {
      console.warn('[AiTerminalMini] flush write error:', e)
      break
    }
  }
  pendingChunksRef.current = { chunks: [], totalBytes: 0 }
}, [])
```

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(AiTerminalMini): buffer output/replay chunks when term not yet open

5MB 上限，溢出丢头部 + console.warn。flushPendingChunks 下个提交在
IO 触发 term.open 后调用。"
```

---

## Task 8: Frontend — WS onopen 走 proposed init 分支

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:606-652` (WS onopen 的 init 上报逻辑)

- [ ] **Step 1: 改写 onopen 的 init 路径**

替换 `web/src/AiTerminalMini.tsx:630-652`（"─── Size-first 握手 ───" 注释之后到 `else { ... doFit() }` 整段）：

```ts
// ─── Size-first 握手 ───
// 走两条路：
// 1) visible 路径：term.cols/rows 已被 fit 算好 —— 像旧逻辑那样直接 init
// 2) hidden-mount 路径：term 还没 open，cols/rows 来自 pendingProposedInitRef
const proposed = pendingProposedInitRef.current
const cols = proposed ? proposed.cols : term.cols
const rows = proposed ? proposed.rows : term.rows

if (isHiddenRef.current) {
  if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_VALID_COLS && rows > 0) {
    ws.send(JSON.stringify({ type: 'init', cols, rows, role: viewerRoleRef.current }))
  }
  sendUnregisterSize(ws)
} else if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= MIN_VALID_COLS && rows > 0) {
  ws.send(JSON.stringify({ type: 'init', cols, rows, role: viewerRoleRef.current }))
  lastSentSizeRef.current = { cols, rows }
} else {
  // 极端 edge case：proposed 也没算出来（祖先链没有 layout 节点）—— 留给后端 30s fallback。
  // 不调 doFit（term 可能还没 open），避免触发未 open 的 fit.fit()。
  console.warn('[AiTerminalMini] no valid init cols at WS onopen; deferring to backend fallback')
}
```

- [ ] **Step 2: 类型检查 + 测试**

Run: `cd web && npx tsc -b --noEmit && cd .. && npx vitest run`
Expected: 全 PASS

- [ ] **Step 3: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(AiTerminalMini): send proposed init on WS open when hidden-mount

修复主线 —— PTY 从此用 proposed cols spawn，不再被 80×24 默认值钉死。
IO 触发 term.open 时的校准 resize 在下一个提交补上。"
```

---

## Task 9: Frontend — IO 首次可见时补 term.open + flush + 校准 resize

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:978-1037` (IntersectionObserver 回调 + justEntered 分支)

- [ ] **Step 1: 改写 IO `justEntered` 分支**

在 `web/src/AiTerminalMini.tsx:982-985`（`if (!justEntered) continue` 之前），插入 term.open 补完逻辑：

```ts
if (nowIn) {
  const justEntered = !wasIntersecting
  wasIntersecting = true
  if (!justEntered) continue

  // 隐藏挂载补完：如果 term 还没 open（首次从 hidden-mount 路径过来），补一波
  if (!termOpenedRef.current) {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) continue
    try {
      term.open(container)
      termOpenedRef.current = true
      try { term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11' } catch {}
      try { term.loadAddon(new CanvasAddon()) } catch {}
      term.write('\x1b[?25l')
      setupImeAndKeyHandlers(term)
      setupLinkProvider(term)
      try { fit.fit() } catch (e) { console.warn('[AiTerminalMini] open-then-fit failed:', e) }
      flushPendingChunks()
      // 实测 cols 与 proposed init 时上报的若不同，补一条 resize 给后端校准
      const proposed = pendingProposedInitRef.current
      if (proposed && (term.cols !== proposed.cols || term.rows !== proposed.rows)) {
        const ws = wsRef.current
        if (ws && ws.readyState === WebSocket.OPEN && term.cols >= MIN_VALID_COLS) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows,
            role: viewerRoleRef.current,
          }))
          lastSentSizeRef.current = { cols: term.cols, rows: term.rows }
        }
      }
      pendingProposedInitRef.current = null
    } catch (e) {
      console.warn('[AiTerminalMini] open-on-visible failed:', e)
      continue
    }
  }

  // 后续原有逻辑：proposeDimensions 对比 + 必要时 hide-fit-reveal + scheduleJustEnteredRefit
  // ... 原代码保持不变
```

注意 `container` 在闭包里是 ResizeObserver 创建时绑定的；这里复用即可。

- [ ] **Step 2: 类型检查 + 测试**

Run: `cd web && npx tsc -b --noEmit && cd .. && npx vitest run`
Expected: 全 PASS

- [ ] **Step 3: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(AiTerminalMini): finish hidden-mount path on first IO visibility

补 term.open + addon load + IME/link 注册 + flush pending chunks + 
（必要时）校准 resize 给后端。"
```

---

## Task 10: Frontend — session_restarted 重置 pending refs

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:714-726` (`case 'session_restarted'`)

- [ ] **Step 1: 在 session_restarted 分支加重置**

在 `web/src/AiTerminalMini.tsx:714-726` 的 `session_restarted` case 里，在 `onSessionSwitchRef.current?.(msg.newSessionId)` **之前**（也就是收到事件第一时间）加：

```ts
case 'session_restarted':
  if (typeof msg.newSessionId === 'string' && msg.newSessionId) {
    // 新 session 的 effect 会重跑：清掉旧 session 的 pending 状态，避免
    // 旧 chunks/proposed init 跨 session 污染
    pendingChunksRef.current = { chunks: [], totalBytes: 0 }
    pendingProposedInitRef.current = null
    // termOpenedRef 不重置 —— termRef.current 还是同一个 term 实例（dispose+重建发生在 effect cleanup），
    // 这里只是状态信号。effect 重跑时 Task 6 的"重置每次 effect 启动时的 hidden-mount 相关状态"
    // 会再次置 false。

    message.info(msg.message || t('session:terminal.message.switchedToManaged'))
    stopReconnectRef.current = true
    setSwitchingMode(false)
    onSessionSwitchRef.current?.(msg.newSessionId)
    useDispatchStore.getState().signal('refreshTodos')
  }
  break
```

- [ ] **Step 2: 类型检查 + 测试**

Run: `cd web && npx tsc -b --noEmit && cd .. && npx vitest run`
Expected: 全 PASS

- [ ] **Step 3: 提交**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(AiTerminalMini): reset pending refs on session_restarted

avoids old session's buffered chunks / proposed init bleeding into the new session."
```

---

## Task 11: 集成测试 — 完整 hidden-mount → visible 时序

**Files:**
- Create: `test/ai-terminal-defer-init.test.ts`

- [ ] **Step 1: 写集成测试**

`test/ai-terminal-defer-init.test.ts`:

```ts
/**
 * Defer-init 时序集成测试
 *
 * 直接对 module-level 辅助函数（proposeColsFromAncestor / measureCharWidth）做断言，
 * 完整组件挂载在 jsdom 下 xterm.js canvas 渲染不稳，不在本测试覆盖（手测验收）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { proposeColsFromAncestor } from '../web/src/AiTerminalMini.tsx'

describe('AiTerminalMini defer-init timing — helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('proposeColsFromAncestor returns valid cols when container is hidden but ancestor is visible', () => {
    const session = document.createElement('div')
    Object.defineProperty(session, 'offsetParent', { value: document.body })
    Object.defineProperty(session, 'clientWidth', { value: 1600 })
    Object.defineProperty(session, 'clientHeight', { value: 900 })
    const hiddenLive = document.createElement('div')
    Object.defineProperty(hiddenLive, 'offsetParent', { value: null })  // display:none
    Object.defineProperty(hiddenLive, 'clientWidth', { value: 0 })
    session.appendChild(hiddenLive)
    document.body.appendChild(session)

    const result = proposeColsFromAncestor(hiddenLive, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)  // MIN_VALID_COLS
    expect(result!.cols).toBeLessThanOrEqual(220)    // 1600 / 7.8 ≈ 205，留 buffer
    expect(result!.rows).toBeGreaterThan(10)
  })

  it('proposeColsFromAncestor uses MIN_VALID_COLS lower bound on narrow viewport', () => {
    const session = document.createElement('div')
    Object.defineProperty(session, 'offsetParent', { value: document.body })
    Object.defineProperty(session, 'clientWidth', { value: 320 })
    Object.defineProperty(session, 'clientHeight', { value: 700 })
    document.body.appendChild(session)

    const result = proposeColsFromAncestor(session, 7.8)
    expect(result).not.toBeNull()
    expect(result!.cols).toBeGreaterThanOrEqual(30)  // 钳到下限
  })
})
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run test/ai-terminal-defer-init.test.ts`
Expected: 全 PASS（2/2）

- [ ] **Step 3: 提交**

```bash
git add test/ai-terminal-defer-init.test.ts
git commit -m "test: add defer-init integration tests for AiTerminalMini helpers"
```

---

## Task 12: 全量回归

**Files:**
- 无修改，纯验证

- [ ] **Step 1: 完整跑测试套件**

Run: `npx vitest run`
Expected: 全部测试 PASS

- [ ] **Step 2: 前端类型检查**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS

- [ ] **Step 3: 前端 build**

Run: `cd web && npm run build`
Expected: build 成功，无 warning

- [ ] **Step 4: 手测验收清单**

启动：`npm run dev`（或正常启动方式，见 README）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 关掉浏览器所有 tab，重启服务，新建 todo + 立刻 AI 执行 | SessionFocus 默认 conversation tab → 切到 Live tab → 内容从顶到底全宽，无窄列 |
| 2 | 已有 running session 的 todo，打开 SessionFocus | 默认 conversation tab → 切到 Live tab → replay 内容全宽 |
| 3 | 1920×1080 视口下浏览器 console 看 `[AiTerminalMini] proposed cols=N1, actual cols=N2` 日志（步骤 7 之前可临时加） | N1 与 N2 误差 ≤ 2 |
| 4 | 跑一次新建 session 等 30 秒，看后端日志 | 没有 `[ai-terminal] spawn fallback fired session=` 出现 |
| 5 | conversation ↔ live 反复切 5 次 | 不应有视觉抖动 / xterm 重渲染 / 内容窄列 |
| 6 | 缩窄浏览器窗口到 600px 分屏 → 再做 #1 | 内容窄但符合视口宽度，不出现 80 cols 钉死 |

- [ ] **Step 5: 删除任何调试日志，最终提交**

```bash
git add -A
git commit -m "fix(ai-terminal): defer init until container is fittable

修完隐藏挂载时 fit 拿 0 宽度后按 80 cols 钉死 PTY 的 bug。
默认 conversation tab 落地体验不受影响，切到 Live 后内容全宽。

Spec: docs/superpowers/specs/2026-05-15-ai-terminal-defer-init-until-fittable-design.md
Plan: docs/superpowers/plans/2026-05-15-ai-terminal-defer-init-until-fittable.md
"
```

- [ ] **Step 6: 推**

```bash
git push origin main
```

---

## Self-Review

### Spec 覆盖

| Spec 要求 | 实现任务 |
|---|---|
| 后端 fallback 5s→30s | Task 1 |
| `measureCharWidth` | Task 2 |
| `proposeColsFromAncestor` | Task 3 |
| `waitTerminalReady` 返回 visibleAndReady | Task 4 |
| `pendingChunksRef` / `pendingProposedInitRef` / `termOpenedRef` | Task 5 |
| 主 effect visible vs hidden 分支 | Task 6 |
| chunks 暂存（含 5MB cap） | Task 7 |
| onopen 走 proposed init | Task 8 |
| IO 首次可见补 term.open + flush + 校准 resize | Task 9 |
| session_restarted 重置 | Task 10 |
| xterm.js write/dispose 探针 | Task 0 |
| 极窄视口钳到 MIN_VALID_COLS | Task 3 |
| 测试 | Task 0, 2, 3, 11 + Task 12 全量 |
| 手测验收 6 条 | Task 12 |

无遗漏。

### 类型一致性

- `{ visibleAndReady: boolean }` 在 Task 4 定义，Task 6 解构使用 ✓
- `pendingChunksRef` 结构 `{ chunks: string[]; totalBytes: number }` 在 Task 5 定义，Task 7/8/9/10 一致使用 ✓
- `proposeColsFromAncestor(container, charWidth): { cols, rows } | null` 在 Task 3 定义，Task 6/8 一致使用 ✓

### 已知风险

- Task 6 的 `setupImeAndKeyHandlers` / `setupLinkProvider` 抽取是机械搬运，但代码量大；如果实现时发现某些 ref（如 `imeComposing` 局部变量）抽出后闭包不正确，需要改成 useRef。建议先 dry-run 一遍再下手。
- Task 0 探针若 `writes buffered before open are visible after open` 失败，会改变 Task 7 的实现细节（pendingChunks 路径不变，但不需要绕开 term.write 的 buffer 行为）。先跑探针。
