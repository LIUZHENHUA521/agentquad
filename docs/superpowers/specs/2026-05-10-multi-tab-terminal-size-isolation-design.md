# 多 tab AI 终端尺寸隔离 — 设计

## 背景

同一个 AI session 被多个浏览器 tab / 窗口同时打开时，PTY 尺寸会"互相污染"——
前台工作中的宽 tab 会被一个早已切到后台的窄 tab 卡住 cols，导致 Claude TUI
按错误宽度折行，scrollback 全是残影。

服务端 (`src/routes/ai-terminal.js:594` `applyAggregatedResize`) 已经实现了
"取所有连接 tab 上报尺寸最小值"的聚合逻辑，但它只在 tab **关闭** 时把该 tab
踢出聚合；tab 仅切到后台并不会移除其上次上报的尺寸，因此后台 tab 的旧尺寸
仍持续约束 PTY。

## 目标

后台 tab 不再参与 PTY 尺寸聚合；切回前台时按当前实际容器尺寸重新加入。

## 非目标

- 不改变 WS 连接生命周期（后台 tab 仍保持连接、继续接收输出 / replay）。
- 不引入"单一驱动 tab"独占模式——保留多个前台 tab 同屏并存时按 min 聚合。
- 不改 PTY 默认尺寸 / 启动参数 / 后端聚合算法本身。
- 不动移动端 WS 的锁屏 / 后台行为（仅复用 visibility 信号控制 resize 上报）。

## 方案：可见性感知聚合

### 协议层

后端 `handleBrowserMessage` 已支持 "resize 收到非法尺寸 → 从聚合移除该 tab"
的分支 (`src/routes/ai-terminal.js:723-727`)：

```js
if (!isValidResizeSize(cols, rows)) {
  delete ws.__quadtodoSize
  applyAggregatedResize(session)
  return
}
```

利用现成分支即可，不新增消息类型。前端 unregister 时发送
`{ type: 'resize', cols: 0, rows: 0 }`，命中 `isValidResizeSize` 失败分支。

### 前端改动 (`web/src/AiTerminalMini.tsx`)

1. **新增 visibility 监听**：组件挂载后注册 `document.visibilitychange`。
2. **隐藏时**：
   - 取消所有 pending fit / resize 定时器。
   - 若 WS 已连接，发一次 `{ type: 'resize', cols: 0, rows: 0 }` 让后端
     unregister 当前 tab 的尺寸。
   - 设置内部标志 `isHiddenRef = true`，让 ResizeObserver / window resize 等
     现有触发点在标志为真时直接 return（不再 fit、不再发 resize）。
   - **不**关闭 WS、**不**清 xterm 状态。
3. **可见时**：
   - 清掉 `isHiddenRef` 标志、清 `lastSentSizeRef`（强制重发）。
   - 触发一次 `doFit()`，让 fit 结果按当前容器实际尺寸重新发 resize。
4. **WS 重连**：现有 onopen 已 reset `lastSentSizeRef` 并 doFit；如果重连发生
   时 tab 是 hidden，则 onopen 后立即再补发一次 `cols:0,rows:0` 来 unregister
   （避免重连把后台 tab 的"旧 fit 结果"再次注入聚合）。

### 后端改动 (`src/routes/ai-terminal.js`)

无需改动。验证 `isValidResizeSize(0, 0)` 返回 false（应该已经返回 false，
要确认：当前实现允许 cols/rows 至少 ≥ 某阈值，0 必然失败）。若不确定，
显式确认实现并按需补一行下限检查。

## 关键边界

| 场景 | 行为 |
|------|------|
| 唯一一个 tab 切后台 | 发 unregister；`applyAggregatedResize` 看到 0 个有效尺寸 → 直接 return（保留 PTY 现状）|
| 唯一前台 tab 切后台后又切回 | doFit + 重发当前 cols/rows，PTY 大概率与之前相同（lastApplied 命中跳过）|
| 两个 tab 都前台（多窗口并排）| visibility 都为 visible，都参与聚合，min 取胜——保留现行多窗口体验 |
| 后台 tab 期间页面 reload / 关闭 | `removeBrowser` 走原路径，正常 |
| visibility 变化时 WS 未连 | 不发任何东西；onopen 时根据当时 visibility 决定发真实尺寸还是 0/0 |

## 验收标准

1. **场景 1**：tab A 宽 1400px、tab B 窄 600px，都前台 → PTY 跑在 B 的 cols。
   把 B 切后台 5s 后 → PTY 跑在 A 的 cols（A 不再受 B 约束）。
2. **场景 2**：B 切回前台 → 200-300ms 内 PTY 缩到 B 的 cols，A 那侧 Claude
   输出在 A 的窗口里按新 cols 自动重排（一次重绘，不抖）。
3. **场景 3**：唯一一个 tab 切后台 → PTY cols/rows 不变（无多余 resize 日志）。
4. **场景 4**：dock 拖宽、折叠 / 展开、popout、split mode 这几条现有路径行为
   不退化（手动测试）。
5. **场景 5**：移动端 Safari，锁屏 → 解锁回到 quadtodo tab，终端正常显示，
   WS 仍连，PTY 尺寸恢复。
6. 服务端 `lastSentSizeRef` 去抖逻辑不被破坏：visibility 反复切换不会产生
   超过预期数量的 PTY resize 调用。

## 风险与缓解

- **iOS Safari visibility 触发不稳**：测试机型覆盖 iOS 17+；如出现切回不
  refit，加一个 `pageshow` 事件冗余触发。
- **后台 tab 期间 ResizeObserver 仍可能 fire**（例如 dock 宽度被 store 同步
  改变）：靠 `isHiddenRef` 标志兜底；fit 直接跳过。
- **0/0 被未来重构当成有效值**：在前端发送处加注释说明用意；后端
  `isValidResizeSize` 加显式 `cols >= MIN_COLS && rows >= MIN_ROWS` 检查
  防御。
