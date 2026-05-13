# 全托管(bypass) 模式切换无缝化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 todo 卡片 / SessionFocus 抽屉里把自动模式从"默认 → 全托管(bypass)"切换时，不再出现 `=== 已中止 ===` 红字、不需要手动关闭重开、有可见且克制的"切换中"反馈。

**Architecture:** 后端在 `handleSetAutoMode` 现有"先 spawn 新 session 再 kill 旧 session"链路上增加 `auto_mode_switching` 预告广播，并在旧 session 被替换时静默 `stopped` 广播；前端补齐 `onSessionSwitch` 从 `SessionFocus` 透传到 `AiTerminalMini` 的链路，让 React 自然 unmount 旧 mini / mount 新 mini，新增 `switchingMode` 中间态做 UI 锁与失败回滚。

**Tech Stack:** Node.js (Express + ws + node-pty), React 18 + TypeScript + Zustand + Ant Design + xterm.js, Vitest (后端单测)

**Spec:** `docs/superpowers/specs/2026-05-12-automode-bypass-switch-fix-design.md`

---

## File Map

**修改：**
- `src/routes/ai-terminal.js` — `handleSetAutoMode` 新增预告广播；`pty.on('done')` 在 replaced 时跳过 `stopped`
- `test/ai-terminal.route.test.js` — 新增 3 个测试覆盖 switching 广播、stopped 静默、失败路径
- `web/src/store/focusStore.ts` — 新增 `replaceFocusedSession` action
- `web/src/store/aiSessionStore.ts` — 新增 `replaceSessionId` action
- `web/src/SessionViewer.tsx` — 透传 `onSessionSwitch` 给 `AiTerminalMini`
- `web/src/components/SessionFocus/SessionFocus.tsx` — 加 `onSessionSwitch` 回调调两个 store
- `web/src/AiTerminalMini.tsx` — `switchingMode` 状态、消息处理、UI 锁、失败回滚、抑制重连

**新建：** 无

---

## Task 1: 后端 — `auto_mode_switching` 预告广播 (TDD)

**Files:**
- Modify: `src/routes/ai-terminal.js:791-851`
- Test: `test/ai-terminal.route.test.js:895-936`（在该测试附近新增）

- [ ] **Step 1: 写失败测试 — 验证 bypass 切换先发 `auto_mode_switching` 再发 `session_restarted`**

在 `test/ai-terminal.route.test.js` 中，在 `it('set_auto_mode bypass restarts a running Claude session with resumeNativeId', ...)` 测试之后插入：

```javascript
  it('set_auto_mode bypass broadcasts auto_mode_switching before session_restarted', async () => {
    const nativeId = 'abcdef12-3456-7890-abcd-ef1234567890'
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude', cwd: '/tmp' })
    ctx.pty.emit('native-session', { sessionId: body.sessionId, nativeId })

    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'set_auto_mode', autoMode: 'bypass' }, ws)

    const switchingIdx = sent.findIndex(m => m.type === 'auto_mode_switching')
    const restartedIdx = sent.findIndex(m => m.type === 'session_restarted')
    expect(switchingIdx).toBeGreaterThanOrEqual(0)
    expect(restartedIdx).toBeGreaterThanOrEqual(0)
    expect(switchingIdx).toBeLessThan(restartedIdx)
    expect(sent[switchingIdx]).toMatchObject({
      type: 'auto_mode_switching',
      target: 'bypass',
    })
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/ai-terminal.route.test.js -t "broadcasts auto_mode_switching"`
Expected: FAIL —— `switchingIdx` 为 -1（消息没发出来）

- [ ] **Step 3: 实现预告广播**

在 `src/routes/ai-terminal.js` 的 `handleSetAutoMode` 中，找到这段：

```javascript
    const todoSnapshot = db.getTodo(session.todoId)
    session.replacedBySessionId = '__pending__'
    let restarted
    try {
      restarted = spawnSession({
```

在 `const todoSnapshot = db.getTodo(session.todoId)` 之前一行（line 811 之前），插入：

```javascript
    broadcastToSession(session, { type: 'auto_mode_switching', target: 'bypass' })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/ai-terminal.route.test.js -t "broadcasts auto_mode_switching"`
Expected: PASS

确保未破坏其他 bypass 测试：
Run: `npx vitest run test/ai-terminal.route.test.js -t "bypass"`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "feat(ai-terminal): broadcast auto_mode_switching before bypass restart"
```

---

## Task 2: 后端 — 被替换的 session 不再广播 `stopped` (TDD)

**Files:**
- Modify: `src/routes/ai-terminal.js` `pty.on('done')` 处理器（约 line 239–310 区间内）
- Test: `test/ai-terminal.route.test.js`（在 Task 1 测试附近）

- [ ] **Step 1: 阅读 `pty.on('done')` 当前实现**

Read: `src/routes/ai-terminal.js` lines 239–310. 注意 `superseded` 标志（约 line 263）已经用来阻止 db 状态回写；这次要把它也用于"是否广播 stopped"。

- [ ] **Step 2: 写失败测试 — 验证 superseded 的旧 session 不再广播 `stopped`/`done`**

在 `test/ai-terminal.route.test.js` 的 Task 1 测试之后插入：

```javascript
  it('superseded old session does not broadcast stopped or done to its WS', async () => {
    const nativeId = 'abcdef12-3456-7890-abcd-ef1234567890'
    const todo = ctx.db.createTodo({ title: 'T', quadrant: 1 })
    const { body } = await request(ctx.app).post('/api/ai-terminal/exec')
      .send({ todoId: todo.id, prompt: 'hi', tool: 'claude', cwd: '/tmp' })
    ctx.pty.emit('native-session', { sessionId: body.sessionId, nativeId })

    const sent = []
    const ws = { readyState: 1, OPEN: 1, send: (d) => sent.push(JSON.parse(d)) }
    ctx.ait.addBrowser(body.sessionId, ws)

    ctx.ait.handleBrowserMessage(body.sessionId, { type: 'set_auto_mode', autoMode: 'bypass' }, ws)

    // 触发被替换的旧 session 退出
    ctx.pty.emit('done', {
      sessionId: body.sessionId,
      exitCode: 0,
      fullLog: '',
      nativeId,
      stopped: true,
    })

    // 收到的消息里不该出现旧 session 的 done/stopped 广播
    const doneMsgs = sent.filter(m => m.type === 'done' || m.type === 'stopped')
    expect(doneMsgs).toEqual([])
  })
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run test/ai-terminal.route.test.js -t "superseded old session"`
Expected: FAIL —— 至少出现一条 done 或 stopped 广播

- [ ] **Step 4: 实现 `done` 事件中的 superseded 静默**

在 `src/routes/ai-terminal.js` 的 `pty.on('done', ...)` 处理器内，找到 line 298–299：

```javascript
    writeFullLog(sessionId, fullLog)
    broadcastToSession(session, { type: 'done', exitCode, status: aiStatus })
```

把这两行改为：

```javascript
    writeFullLog(sessionId, fullLog)
    const replacedByLive = superseded
      && typeof session.replacedBySessionId === 'string'
      && session.replacedBySessionId !== '__pending__'
    if (!replacedByLive) {
      broadcastToSession(session, { type: 'done', exitCode, status: aiStatus })
    }
```

`superseded` 已在 line 263 计算好。`__pending__` 是 `handleSetAutoMode` 在 spawn 之前的占位值，失败回滚分支会 `delete session.replacedBySessionId`，因此只有"真的被新 session 替换"才匹配 `replacedByLive === true`。

> 注意：不要改 db / `aiSessions` 清理逻辑（line 263–296）；不要动 `insertSessionLog`（line 302–316）；不要动 `onSessionEnded` 钩子（line 318–329 已经判断了 `!superseded`）。**只跳过那一行 ws 广播**。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run test/ai-terminal.route.test.js -t "superseded old session"`
Expected: PASS

回归：
Run: `npx vitest run test/ai-terminal.route.test.js`
Expected: 全部 PASS（特别注意 `old session exit during runtime bypass restart` 这个测试仍然 PASS —— 它检查的是 db 状态不被覆盖，不依赖 stopped 广播）

- [ ] **Step 6: Commit**

```bash
git add src/routes/ai-terminal.js test/ai-terminal.route.test.js
git commit -m "fix(ai-terminal): suppress stopped broadcast for superseded sessions"
```

---

## Task 3: 前端 store — `focusStore` 新增 `replaceFocusedSession`

**Files:**
- Modify: `web/src/store/focusStore.ts`

- [ ] **Step 1: 在 `FocusState` 接口中新增 action 类型**

在 `web/src/store/focusStore.ts` 的 `interface FocusState` 中，在 `setTab` 行后添加：

```typescript
  replaceFocusedSession: (oldId: string, nextId: string) => void
```

- [ ] **Step 2: 在 `create` 里实现 action**

在 `setTab` 的 action 实现下面追加：

```typescript
  replaceFocusedSession: (oldId, nextId) => set((state) => {
    if (state.focusedSessionId !== oldId) return state
    return { focusedSessionId: nextId }
  }),
```

- [ ] **Step 3: 类型检查**

Run: `cd web && npx tsc -b`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add web/src/store/focusStore.ts
git commit -m "feat(focusStore): add replaceFocusedSession action for session hot-swap"
```

---

## Task 4: 前端 store — `aiSessionStore` 新增 `replaceSessionId`

**Files:**
- Modify: `web/src/store/aiSessionStore.ts`

- [ ] **Step 1: 在 `AiSessionState` 接口中新增 action 类型**

在 `interface AiSessionState` 的 `reset: () => void` 上方添加：

```typescript
  replaceSessionId: (oldId: string, nextId: string) => void
```

- [ ] **Step 2: 实现 action**

在 `useAiSessionStore` 的 `reset` action 之前添加：

```typescript
  replaceSessionId: (oldId, nextId) => set((state) => {
    const oldSession = state.sessions.get(oldId)
    if (!oldSession) return {}
    const sessions = new Map(state.sessions)
    sessions.delete(oldId)
    sessions.set(nextId, { ...oldSession, sessionId: nextId })

    const moveMap = <V,>(src: Map<string, V>): Map<string, V> => {
      if (!src.has(oldId)) return src
      const next = new Map(src)
      const v = next.get(oldId)
      next.delete(oldId)
      if (v !== undefined) next.set(nextId, v)
      return next
    }

    return {
      sessions,
      outputSamples: moveMap(state.outputSamples),
      outputRates: moveMap(state.outputRates),
      resources: moveMap(state.resources),
      resourceHistory: moveMap(state.resourceHistory),
    }
  }),
```

> Note: 即便 `oldSession` 在 store 里还没有出现（罕见 race），也走 no-op 不抛错。后续 `live-sessions` 轮询会自然补齐。

- [ ] **Step 3: 类型检查**

Run: `cd web && npx tsc -b`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add web/src/store/aiSessionStore.ts
git commit -m "feat(aiSessionStore): add replaceSessionId for bypass switch hot-swap"
```

---

## Task 5: `SessionViewer` 透传 `onSessionSwitch`

**Files:**
- Modify: `web/src/SessionViewer.tsx`

- [ ] **Step 1: 透传 props 给 `<AiTerminalMini>`**

在 `web/src/SessionViewer.tsx` 中，找到这行（约 line 70）：

```tsx
        <AiTerminalMini {...props} fillHeight={fillHeight} />
```

`{...props}` 已包含所有声明的 props（包括 `onSessionSwitch`），无需改动。**确认**该行未把 `onSessionSwitch` 显式 omit。如果 `{...props}` 里把 `mode` / `onModeChange` / `hideTabs` 这些 SessionViewer-only 的字段也透传给 AiTerminalMini，需要排除（AiTerminalMini 不需要它们但 TypeScript 接受额外 props）。

> 实际情况：`{...props}` 透传方式没问题，因为 props 类型 `Props extends AiTerminalMini Props + 额外字段`，多余字段 React 会忽略。**这一步是确认无需改动**。

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc -b`
Expected: 无错误

- [ ] **Step 3: 跳过 commit（无改动）**

如果文件确实未改，跳过 commit。否则 commit。

> 如果你发现 `{...props}` 因为某种原因没透传 `onSessionSwitch`（比如显式解构后忘了传），把它补上：
> ```tsx
> <AiTerminalMini {...props} onSessionSwitch={props.onSessionSwitch} fillHeight={fillHeight} />
> ```

---

## Task 6: `SessionFocus` 接 `onSessionSwitch` 回调

**Files:**
- Modify: `web/src/components/SessionFocus/SessionFocus.tsx`

- [ ] **Step 1: 引入两个 store 的 action**

在 `web/src/components/SessionFocus/SessionFocus.tsx` 顶部，找到现有的 store 用法（约 line 11–18），紧接着把：

```typescript
  const focusedSessionId = useFocusStore((s) => s.focusedSessionId)
```

下一行改为同时 select `replaceFocusedSession`：

```typescript
  const focusedSessionId = useFocusStore((s) => s.focusedSessionId)
  const replaceFocusedSession = useFocusStore((s) => s.replaceFocusedSession)
```

并在 `const sessions = useAiSessionStore((s) => s.sessions)` 之后加：

```typescript
  const replaceSessionId = useAiSessionStore((s) => s.replaceSessionId)
```

- [ ] **Step 2: 定义 `handleSessionSwitch` 回调**

在 `if (!focusedTodoId) return null` 之前插入：

```typescript
  const handleSessionSwitch = (nextSessionId: string) => {
    if (!focusedSessionId) return
    replaceSessionId(focusedSessionId, nextSessionId)
    replaceFocusedSession(focusedSessionId, nextSessionId)
  }
```

> 顺序很重要：先更 `aiSessionStore`（保证 `useAiSessionStore` 读取到的 sessions 已含 newId），再切 `focusedSessionId` 触发 SessionViewer 重渲染。

- [ ] **Step 3: 把回调传给 `<SessionViewer>`**

找到 `<SessionViewer ...>` 标签（约 line 71），在 `onClose={clearFocus}` 后加：

```tsx
              onSessionSwitch={handleSessionSwitch}
```

- [ ] **Step 4: 类型检查 + 全量 build**

Run: `cd web && npx tsc -b`
Expected: 无错误

Run: `cd web && npm run build`
Expected: build 成功

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SessionFocus/SessionFocus.tsx web/src/SessionViewer.tsx
git commit -m "fix(focus): wire onSessionSwitch to update focus + ai session stores"
```

---

## Task 7: `AiTerminalMini` — `switchingMode` 状态 + 处理预告消息

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`

- [ ] **Step 1: 新增 state 和 ref**

在 `web/src/AiTerminalMini.tsx` 找到 `autoMode` state 声明（line 150）下方插入：

```typescript
  const [switchingMode, setSwitchingMode] = useState(false)
  const prevAutoModeRef = useRef<string | null>(autoMode)
```

- [ ] **Step 2: 在 WS 消息处理里加 `auto_mode_switching` case**

在 `web/src/AiTerminalMini.tsx` 找到 `case 'auto_mode':`（line 717）下方的 `case 'session_restarted':` 之前插入：

```typescript
              case 'auto_mode_switching':
                if (msg.target) setAutoMode(msg.target)
                setSwitchingMode(true)
                break
```

- [ ] **Step 3: `session_restarted` 收到后清掉 `switchingMode`，并阻止旧 WS 重连**

修改现有 `case 'session_restarted':`（line 720–724）为：

```typescript
              case 'session_restarted':
                if (typeof msg.newSessionId === 'string' && msg.newSessionId) {
                  message.info(msg.message || '已切换到恢复后的全托管会话')
                  stopReconnectRef.current = true  // 旧 WS 关闭后不再自动重连
                  setSwitchingMode(false)
                  onSessionSwitchRef.current?.(msg.newSessionId)
                }
                break
```

- [ ] **Step 4: `auto_mode_notice` 收到 `restart_failed` 时回滚**

修改现有 `case 'auto_mode_notice':`（line 726–728）为：

```typescript
              case 'auto_mode_notice':
                if (msg.reason === 'restart_failed') {
                  setSwitchingMode(false)
                  setAutoMode(prevAutoModeRef.current)
                  try {
                    if (prevAutoModeRef.current) localStorage.setItem('quadtodo.autoMode', prevAutoModeRef.current)
                    else localStorage.removeItem('quadtodo.autoMode')
                  } catch { /* ignore */ }
                  if (msg.message) message.error(msg.message)
                } else if (msg.message) {
                  message.warning(msg.message)
                }
                break
```

- [ ] **Step 5: `handleSetAutoMode` 在发起切换前记录旧值**

修改现有 `handleSetAutoMode`（line 1074）为：

```typescript
  const handleSetAutoMode = useCallback((mode: string | null) => {
    prevAutoModeRef.current = autoMode
    setAutoMode(mode)
    try {
      if (mode) localStorage.setItem('quadtodo.autoMode', mode)
      else localStorage.removeItem('quadtodo.autoMode')
    } catch { /* ignore */ }
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_auto_mode', autoMode: mode }))
    }
  }, [autoMode])
```

- [ ] **Step 6: 类型检查**

Run: `cd web && npx tsc -b`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(ai-terminal): track switchingMode state and handle restart_failed rollback"
```

---

## Task 8: `AiTerminalMini` — UI 锁与切换中提示

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`

- [ ] **Step 1: 引入 `Spin` 组件**

在 `web/src/AiTerminalMini.tsx` 顶部找到 antd 的 import（应该包含 Tag、Dropdown、Button、message 等），把 `Spin` 加进 import 列表：

```typescript
import { Tag, Dropdown, Button, message, Spin /* 其他已有 */ } from 'antd'
```

（如果已经 import 过 Spin，跳过此步）

- [ ] **Step 2: dropdown 在 `switchingMode` 时 disable**

找到 mode dropdown 渲染（line 1278–1298），把 `<Dropdown menu={{ ... trigger={['click']}>` 改为：

```tsx
        {isActive && !sessionExpired && (
          <Dropdown
            menu={{
              items: [
                { key: 'default', label: '默认（需确认）' },
                { key: 'acceptEdits', label: '半托管（编辑自动通过）' },
                { key: 'bypass', label: '完全托管（全自动）' },
              ],
              selectedKeys: [autoMode || 'default'],
              onClick: ({ key }) => handleSetAutoMode(key === 'default' ? null : key),
            }}
            trigger={['click']}
            disabled={switchingMode}
          >
            <Tag
              color={autoMode === 'bypass' ? 'orange' : autoMode === 'acceptEdits' ? 'blue' : 'default'}
              style={{
                fontSize: 10, lineHeight: '16px', margin: 0,
                cursor: switchingMode ? 'wait' : 'pointer',
                userSelect: 'none',
                opacity: switchingMode ? 0.6 : 1,
              }}
            >
              {switchingMode ? (
                <>
                  <Spin size="small" style={{ marginRight: 4 }} />
                  切换中…
                </>
              ) : (
                <>
                  {autoMode === 'bypass' ? '全托管' : autoMode === 'acceptEdits' ? '半托管' : '手动'}
                  {' '}<DownOutlined style={{ fontSize: 7 }} />
                </>
              )}
            </Tag>
          </Dropdown>
        )}
```

- [ ] **Step 3: 终端容器在 `switchingMode` 时屏蔽输入**

找到终端容器 div（line 1494–1510，`ref={containerRef}` 那个 div），在其 `style={{ ... }}` 块的末尾追加 `pointerEvents` 和 `opacity`：

把：

```tsx
        style={{
          flex: (fullscreen || fillHeight) ? 1 : undefined,
          minHeight: (fullscreen || fillHeight) ? 0 : undefined,
          height: (fullscreen || fillHeight) ? undefined : height,
          width: '100%',
          position: 'relative',
          /* 其余样式不动 */
        }}
```

改为追加两个字段（保留其余）：

```tsx
        style={{
          flex: (fullscreen || fillHeight) ? 1 : undefined,
          minHeight: (fullscreen || fillHeight) ? 0 : undefined,
          height: (fullscreen || fillHeight) ? undefined : height,
          width: '100%',
          position: 'relative',
          pointerEvents: switchingMode ? 'none' : undefined,
          opacity: switchingMode ? 0.6 : 1,
          transition: 'opacity 0.2s',
          /* 其余原有样式保持 */
        }}
```

> 注意：如果已有的 `style` 对象后面还有其他字段（如 background、border 等），把这两行插入到合适位置即可，不要删原有字段。

- [ ] **Step 4: 类型检查**

Run: `cd web && npx tsc -b`
Expected: 无错误

- [ ] **Step 5: 全量 build**

Run: `cd web && npm run build`
Expected: build 成功，无 TS 报错

- [ ] **Step 6: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(ai-terminal): show switching state and lock terminal during bypass swap"
```

---

## Task 9: 后端回归测试 + 完整测试套件

**Files:** 无（仅运行测试）

- [ ] **Step 1: 跑完整后端单测**

Run: `npm test`
Expected: 全部 PASS（如果有无关失败，记录到 commit message 但不修——不属于本次范围）

- [ ] **Step 2: 跑 ai-terminal 路由测试单独确认**

Run: `npx vitest run test/ai-terminal.route.test.js`
Expected: 全部 PASS，特别包括：
- `set_auto_mode bypass restarts a running Claude session with resumeNativeId`
- `set_auto_mode bypass broadcasts auto_mode_switching before session_restarted`（Task 1 新增）
- `superseded old session does not broadcast stopped or done to its WS`（Task 2 新增）
- `runtime bypass restart failure restores old session state and warns browser`
- `runtime bypass old-session stop does not call session-ended hooks`
- `set_auto_mode bypass does not restart Claude when nativeSessionId is missing`

---

## Task 10: 手动验收

**Files:** 无（在浏览器跑 dev server）

- [ ] **Step 1: 启动 dev 环境**

Run: `npm start &` 拉起后端
Run: `cd web && npm run dev` 拉起前端 dev server
打开浏览器到 dev server 给出的 URL（通常 `http://localhost:5173`）

- [ ] **Step 2: 验收场景 1 — 默认 → 全托管 无缝**

操作：
1. 创建一个 todo（任意四象限）
2. 用 Claude 工具启动一个 AI session，等 dropdown 出现"手动"标签
3. 跟 AI 简单对话一句（让它有 native session id；可以问"你好"等它回复）
4. 点 dropdown → 选"完全托管（全自动）"

期望：
- ✅ dropdown 立即变成 "切换中…" + spinner
- ✅ 终端区变成半透明、不响应点击/键盘
- ✅ **不出现** `=== 已中止 ===` 红字
- ✅ 1–3s 内 dropdown 稳定到橙色 "全托管"
- ✅ 不需要手动关闭抽屉/刷新
- ✅ 再发问，AI 能记住切换前的对话上下文

- [ ] **Step 3: 验收场景 2 — 切换中键盘输入被忽略**

操作：和场景 1 一样切到全托管，**在 dropdown 显示"切换中…"期间**疯狂敲键盘。

期望：
- ✅ 字符不出现在新终端（不会发到旧 PTY，新 PTY 还没起来时被屏蔽）

- [ ] **Step 4: 验收场景 3 — `acceptEdits` 切换不受影响**

操作：从"手动"或"全托管"切到"半托管（编辑自动通过）"

期望：
- ✅ 无 "切换中…" spinner
- ✅ 终端不锁
- ✅ 立即切换，dropdown 变成蓝色 "半托管"

- [ ] **Step 5: 验收场景 4 — 失败回滚（可选，需要构造失败）**

如果方便：
- 临时在 `src/routes/ai-terminal.js` 的 `spawnSession` 内插一行 `throw new Error('test failure')`（仅当 `permissionMode === 'bypass'` 时），重启后端
- 重复场景 1 的切换

期望：
- ✅ Antd toast 显示 "切换全托管失败：test failure"
- ✅ dropdown 回退到切换前的状态（"手动"）
- ✅ 终端解锁，原 session 继续可用

测试后**记得 revert** 那行 throw。

- [ ] **Step 6: 验收场景 5 — PipelineRunDrawer 未退化**

操作：触发一个 pipeline run（如果有现成的 pipeline 入口），打开 RunDrawer 看子终端是否照常显示。

期望：
- ✅ Pipeline 终端正常显示输出，无新错误，无 "切换中" spinner（pipeline 进程不暴露自动模式 dropdown，应保持原状）

- [ ] **Step 7: 关闭 dev 服务**

Run: 在两个 dev 窗口分别 Ctrl-C
Run: `npm run stop` 如果后端是后台启动的

---

## Task 11: 最终 commit + 总结

**Files:** 可能无新改动；如果手动验收发现小问题，单独 commit 修复

- [ ] **Step 1: 确认所有改动已 commit**

Run: `git status`
Expected: working tree clean（或仅剩 Task 10 临时实验的痕迹，已 revert）

- [ ] **Step 2: 查看本次所有 commits**

Run: `git log --oneline main..HEAD`
Expected: 看到 Task 1、2、3、4、6、7、8 的 commits（Task 5 通常无 commit）

- [ ] **Step 3: 整理（可选）**

如果分得太碎，可以 `git rebase -i` 合并；但 spec 建议保持 frequent commits 的粒度。

---

## 自审清单

- [x] Spec 覆盖：
  - "auto_mode_switching" 协议 → Task 1
  - superseded session 不广播 stopped → Task 2
  - SessionViewer 透传 → Task 5
  - SessionFocus 接回调 → Task 6
  - focusStore.replaceFocusedSession → Task 3
  - aiSessionStore.replaceSessionId → Task 4
  - AiTerminalMini 切换中状态 + UI 锁 + 失败回滚 + 阻止旧 WS 重连 → Task 7, 8
  - 5 个手动验收场景 → Task 10
  - 后端单测 → Task 1, 2 (TDD)
- [x] 无 placeholder（"TBD" / "handle error appropriately" / "implement later"）
- [x] 类型一致：`replaceFocusedSession(oldId, nextId)` 与 `replaceSessionId(oldId, nextId)` 签名一致；`auto_mode_switching` 协议字段 `target` 后端发什么前端就读什么
- [x] 每个改动步骤都附了具体代码块
- [x] 每个测试都有运行命令和期望结果
