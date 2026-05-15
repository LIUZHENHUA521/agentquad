# AI 终端 — 推迟 init 到容器可量度，修复隐藏挂载导致的窄 cols

**Date**: 2026-05-15
**Status**: Draft
**Owner**: lzh

## 问题陈述

打开任意 todo 进入 `SessionFocus` → 默认落在 **Conversation tab**（`focusStore.focusedTab = 'conversation'`）→ Live tab 容器初始 `display:none`。

`AiTerminalMini` 仍然挂载，并立刻执行：
1. `waitTerminalReady(container)` 等 `offsetParent !== null && clientWidth >= MIN_CONTAINER_WIDTH`。隐藏容器永远不满足 → 3s 后超时跳出循环。
2. 在隐藏容器里硬开 `term.open()` + `fit.fit()` → FitAddon 测量到 `offsetWidth = 0` → `term.cols` 落到 xterm 默认值（80）或更窄。
3. WS `init` 上报这个错的 cols。后端 `pty.startWithSize(clampedCols, rows)` → **claude/codex 用 80 cols spawn**。

claude/codex 是按 PTY cols 输出 TUI / 字符画 / 软折行 / 硬换行。一旦 PTY 用窄 cols spawn，**已经写下的行带着硬换行 + 框线坐标永远不会回流**。后续用户切到 Live tab → `IntersectionObserver` 触发 doFit → cols 修正 → `resize` 发给后端 → 之后的新输出按宽 cols 来，但**已积累的输出停留在窄 cols**。

复现：进入任意正在跑的 todo → 默认在 Conversation → 切到 Live → 滚动 xterm 到顶部，能看到一大段窄列内容，右侧留空。截图位置即此。

## 根因（一句话）

`focusStore.focusedTab = 'conversation'` 让 `AiTerminalMini` 在 `display:none` 容器里跑 fit，测出 0 宽度后用默认 80 cols 发 init，把 PTY 钉死在 80。

## 范围

**仅影响** `AiTerminalMini` 的首次 init 时序与 `ai-terminal.js` 的 spawn fallback 时长。**不动**：

- `focusStore` 默认 tab（保留主人喜欢的 conversation 落地体验）。
- `SessionViewer` 的 `display:none` ↔ `display:flex` tab 切换布局。
- xterm 主题、IO/RO 重 fit、role 聚合、resize 去抖等所有已有机制。

## 设计

### 一、前端：`AiTerminalMini` 主 effect

#### A1. 新增字符宽度测量工具 (`measureCharWidth`)

一次性测量 `13px "JetBrains Mono"` 的等宽字符宽度。实现：

```ts
async function measureCharWidth(): Promise<number> {
  await document.fonts.ready
  const probe = document.createElement('span')
  probe.style.cssText = `
    position: absolute; visibility: hidden;
    font: 13px "JetBrains Mono", Menlo, Monaco, "Courier New", monospace;
    white-space: pre; padding: 0; border: 0;
  `
  probe.textContent = 'M'.repeat(100)
  document.body.appendChild(probe)
  const width = probe.getBoundingClientRect().width / 100
  document.body.removeChild(probe)
  return width
}
```

字体未加载完时退回到 fallback `~7.8` (JetBrains Mono 13px 经验值)。结果**模块级缓存**，session 内只测一次。

#### A2. 新增祖先尺寸探测 (`proposeColsFromAncestor`)

```ts
function proposeColsFromAncestor(
  container: HTMLElement,
  charWidth: number,
): { cols: number; rows: number } | null {
  // 自下而上找第一个真正有布局的祖先
  let el: HTMLElement | null = container
  while (el) {
    if (el.offsetParent !== null && el.clientWidth >= MIN_CONTAINER_WIDTH) {
      // 找到了 —— 减去 wrapper 的 1px×2 border 和 xterm 内部 padding (~14px)
      const availableW = Math.max(el.clientWidth - 2 - 14, MIN_PROPOSED_WIDTH /* ~280px */)
      // height 不准没关系（rows 算错对 PTY 影响小），IO 触发后 fit 会校准
      const availableH = (el.clientHeight || window.innerHeight * 0.6) - 60 /* toolbar+padding */
      const cols = Math.max(Math.floor(availableW / charWidth), MIN_VALID_COLS)
      const rows = Math.max(Math.floor(availableH / 18 /* lineHeight 经验值 */), 10)
      return { cols, rows }
    }
    el = el.parentElement
  }
  return null
}
```

减去的常数（2, 14, 60, 18）取自当前 CSS 实际值，作为模块级常量。

**极窄视口策略**：用 `Math.max(..., MIN_VALID_COLS)` 把 proposed cols 钳到 `MIN_VALID_COLS` 下限（30 cols，对齐后端 `isValidResizeSize`），保证：

- 哪怕用户把窗口拉到 600px 分屏，proposed 也会发出去，PTY 按 30~40 cols spawn（窄但合理）；
- 不会因为算出 < `MIN_VALID_COLS` 直接 return null → 30s fallback → 80 cols（等于 bug 复发）。

`MIN_PROPOSED_WIDTH` 保证除法不出负值。

#### A3. 改写 `waitTerminalReady` 的退出路径

当前：

```ts
while (Date.now() - start < TIMEOUT_MS) {
  if (container.offsetParent !== null && container.clientWidth >= MIN_CONTAINER_WIDTH) break
  await sleep(50)
}
// 超时也跳出
```

改为：

```ts
let visibleAndReady = false
while (Date.now() - start < TIMEOUT_MS) {
  if (container.offsetParent !== null && container.clientWidth >= MIN_CONTAINER_WIDTH) {
    visibleAndReady = true
    break
  }
  await sleep(50)
}
// 字体仍然 await，原逻辑保留
return { visibleAndReady }  // 把结果告诉调用方
```

#### A4. 改写主 effect 中 init 上报路径

当前 `waitTerminalReady` 之后立刻 `term.open(container) + fit.fit() + ws.send({type:'init', cols, rows})`，**无论 container 是不是真的有尺寸**。

改为：

```ts
const { visibleAndReady } = await waitTerminalReady(container)

if (visibleAndReady) {
  // 正常路径：term.open + fit.fit + 真实 cols 发 init
  term.open(container)
  fit.fit()
  ws.send({ type: 'init', cols: term.cols, rows: term.rows, role })
} else {
  // 隐藏挂载路径：用 proposed cols 发 init，term 暂不 open，等 IO 触发
  const charWidth = await measureCharWidth()
  const proposed = proposeColsFromAncestor(container, charWidth)
  if (proposed) {
    ws.send({ type: 'init', cols: proposed.cols, rows: proposed.rows, role })
    pendingProposedInit = proposed  // 标记 term 还没 open
  }
  // term.open 推迟到 IO 首次 isIntersecting 时再做
}
```

#### A5. `IntersectionObserver` 首次可见的补完逻辑

当前 IO 进入 `isIntersecting=true` 分支会 doFit + 滚到底。改为：

```ts
if (justEntered) {
  if (!term.element) {
    // 隐藏挂载路径：现在容器真的可见了，补 term.open
    term.open(container)
    fit.fit()
    if (pendingProposedInit) {
      // 实测 cols 若与 proposed 不同，就发 resize；否则跳过
      if (term.cols !== pendingProposedInit.cols || term.rows !== pendingProposedInit.rows) {
        ws.send({ type: 'resize', cols: term.cols, rows: term.rows, role })
      }
      pendingProposedInit = null
    }
    // 把 replay 缓存的 chunks 写下去（如果 WS 已经收到 replay）
    flushPendingReplay()
  }
  // 原有逻辑：doFit + scrollToBottom + reveal
  // ...
}
```

`flushPendingReplay`：在 term.open 之前，`onmessage` 收到的 `replay` chunks 暂存到 ref 里；open 完成后一并写入。

#### A6. `term` 未 open 期间的 WS 消息处理

- `output` / `replay` chunks → 暂存到 `pendingChunksRef`（结构：`{ chunks: string[], totalBytes: number }`）。term.open 后 flush。
- `pending_confirm` / `turn_done` / `auto_mode` / `done` 等 → 与 term 无关，正常处理。
- `session_restarted` → 见 A7。

**xterm.js 写入约束**：xterm.js 的 `Terminal` 实例在 `open()` 之前调用 `write()` 会写入内部 buffer，open 时一次性渲染——这是 xterm.js 文档允许的用法（见 xterm.js v5 `_innerWrite` 行为），但本 spec 不依赖这一点。我们走"显式暂存 + flush"路径更可控：

- 实现前先写一个 jsdom 探针测试，断言：
  - `new Terminal({...})` 后立刻 `term.write('foo')` 不抛
  - 之后 `term.open(div)` 后 `term.buffer.active.getLine(0)` 能读到 `foo`
- 如果探针失败 → 走纯 `pendingChunksRef` 路径（不动 term，直到 open 完后 flush）。

**内存上限**：

- `pendingChunksRef.totalBytes` 累加每个 chunk 的字节数；上限 **5 MB**（足够覆盖 `outputHistory` 默认 cap，正常 codex/claude 长任务也很少超）。
- 溢出时**保留尾部、丢弃头部**（拼接后从末尾留 5MB）+ console.warn 一次。
- 用户从来不切 Live 的极端场景下不会爆内存。

#### A7. `session_restarted` 在 term 未 open 时的处理

收到 `session_restarted`（auto_recover / 手动 recover）时，无论 term 是否已 open：

1. `pendingChunksRef = { chunks: [], totalBytes: 0 }`（清空旧 session 残留）
2. `pendingProposedInit = null`（旧 proposed 作废）
3. `onSessionSwitch(newSessionId)` 触发主 effect 重跑（依赖 sessionId）
4. 主 effect 重跑时：若 container 仍处于隐藏挂载状态，**重新走 proposed init 路径**；可见则走实测路径
5. 新 WS 连入后端的 replay 按上面规则继续暂存或直写

`term.dispose()` 在 term 从未 open 的情况下也是安全的（xterm.js 的 dispose 仅清 listeners + buffer，不依赖 DOM）。同样在实现前写 1 行探针确认。

### 二、后端：`src/routes/ai-terminal.js`

#### B1. `spawnFallbackTimer` 5s → 30s

```js
session.spawnFallbackTimer = setTimeout(() => {
  // ... 现有逻辑保留：用 80×24 spawn 兜底
}, 30_000)  // 原 5000
```

理由：

- 正常路径前端已经在 ~100ms 内根据 proposed cols 发了 init，30s 不会真正触发。
- 边界情况（前端 JS 报错 / 完全没连 WS）下保留 80×24 fallback，避免 session 永远卡 create 状态。
- 30s 比 5s 留出足够 buffer 等前端从 conversation tab 默认体验切到 Live tab。

#### B2. 不改 `init` 的 spawn 触发逻辑

当前 init 收到 → `pty.startWithSize(cols, rows)` 一气呵成。这条不动，前端 proposed cols 走同样路径。

### 三、风险点与缓解

| 风险 | 评估 | 缓解 |
|---|---|---|
| Proposed cols 与实测 cols 差 ±1 ~ ±2 | 中。字符宽度 JBM 13px 7.8px 与浏览器抗锯齿、subpixel 渲染会差零点几像素 | A5 里 IO 触发后会发 resize 校准。差 1-2 cols 时 claude/codex 的 SIGWINCH 处理会 redraw 当前屏，不影响视觉 |
| `proposeColsFromAncestor` 找不到有效祖先 | 低。SessionFocus 的 `.session-focus` 是 `position:fixed; inset:topbar 0 0 0`，永远 layout | 兜底返回 null → 不发 init → 后端 30s fallback 用 80×24 spawn（即旧行为，安全退化） |
| `term` 未 open 期间用户切到 Live → IO 触发 open → 但 WS 早已发 proposed init → 后端已经 spawn → replay chunks 进入 pending buffer | 这是预期路径。flushPendingReplay 把 chunks 一次性 `term.write()` 给 xterm | 测试需覆盖：proposed init → spawn → output → 用户切 Live → flush 后内容完整 |
| 字体未加载完时 `measureCharWidth` 返回 fallback 7.8 | 低。`document.fonts.ready` 在 `waitTerminalReady` 阶段已 await | fallback 与实测差小于 5%，cols 误差 ≤ 5%，IO 触发后会 resize 校准 |
| 多 viewer 场景（telegram bot / openclaw / 另一个浏览器 tab 都连同一 session） | viewer 聚合走 `applyAggregatedResize`，未发 init 的 ws 跳过。primary viewer (前端 SessionFocus) 即使在隐藏挂载阶段用 proposed cols，也是 valid contribution | 无需额外处理 |
| 5s → 30s 后，前端真的挂掉的情况 PTY 半分钟才 spawn | 低概率。前端正常情况下挂载即测+发 init（< 100ms） | 监控埋点可加：如果 30s fallback 真触发，warn 日志保留 |

### 四、不做

- 不改 `focusStore.focusedTab` 默认值。理由：(a) 一行改回 `'live'` 最简单，但 conversation 落地是已对齐的产品决策（`focusStore.ts:22` "Default landing tab matches mockup"）；(b) 即便改了默认 tab，用户切回 conversation 再切 Live 仍能复现 bug——根因是"隐藏挂载时 fit 拿 0 宽"，改默认 tab 只是压低概率，不治本。
- 不改 `SessionViewer` 的 `display:none` ↔ `display:flex` 切换（保留所有现有 tab 切换/scroll 状态优化）。
- 不引入 "absolute overlay both panes" 的布局重构（侵入太多组件）。
- 不处理已经在窄 cols 跑的 stale session（用户手动重启）。
- 不动 `viewerRole='secondary'` 的 ws 行为（它本来就只是 size 贡献者）。

## 验收

### 必过

1. **冷启动新 todo + 默认 conversation tab**：点 todo 卡片"AI 执行" → SessionFocus 默认 conversation → claude/codex 启动 → 切到 Live tab → xterm 内容从头到尾全宽，无窄列。
2. **resume 已 running 的 todo**：进 SessionFocus 默认 conversation → 切到 Live tab → xterm 显示的 replay 内容全宽。
3. **proposed cols 与实测 cols 误差**（手测）：在 1920×1080 视口下，proposed cols 与 IO 触发后实测 cols 差 ≤ 2（看浏览器 console 日志）。
4. **30s fallback 不触发**：正常 dev 环境跑一次新建 session，30s 兜底定时器不应该 fire（看后端日志无 `spawn fallback fired`）。
5. **现有测试全绿**：`test/ai-terminal*.test.*` 全部通过。

### 不能回归

- 一开始就在 Live tab 的体验：依然零闪、依然 viewport reveal 时序正确。
- 切 conversation ↔ live 来回切：依然不抖、不重发重复 init。
- `viewerRole='primary'` 仍生效，不被 proposed cols 静默打回 secondary。
- 切 session（session_restarted / auto_recover）后新 session 的 cols 也走 proposed 路径。

### 新增测试

`test/ai-terminal-defer-init.test.ts`（jsdom）：

1. mount 时 container 处于 display:none 父容器中 → 不应调用 `term.open` → 应通过 ws.send 发出 `{type:'init', cols, rows}` 且 cols >= MIN_VALID_COLS。
2. 切到 display:flex 触发 IO → 应调用 `term.open` → flush 暂存的 chunks 到 term。
3. proposed cols 与 IO 触发后实测 cols 不同 → 应发一次 resize。
4. proposed cols 与实测 cols 相同 → 不发额外 resize。

## 实现顺序（给 writing-plans 用）

1. 后端：`spawnFallbackTimer` 5s → 30s（1 行改动 + 注释更新）。
2. 前端：`measureCharWidth` + `proposeColsFromAncestor` 工具函数。
3. 前端：改写 `waitTerminalReady` 返回 `visibleAndReady`。
4. 前端：改写主 effect 的 init 上报分支（visibleAndReady ? 实测 : proposed）。
5. 前端：pendingChunksRef + flushPendingReplay 实现。
6. 前端：IO 首次可见时补 `term.open` + 校准 resize。
7. 新增测试。
8. 手测验收清单 1-5。
