# 孤儿会话状态清理（方案 C：后端正本清源）

## 背景

进入 SessionFocus 时，可能同时看到「{tool} · 运行中」绿色 pill 和「恢复会话」按钮——
两个语义互相矛盾：运行中的会话不该需要恢复，需要恢复的会话不该展示为运行中。

根因在后端：

- `pty.on('done')` 正常退出路径已经会把 `todo.aiSessions[i].status` 写成
  `'done' / 'stopped' / 'failed'`，这条路无 bug。
- **服务硬重启 / crash** 时 PTY 进程没机会触发 `onExit`，DB 里 `status='running'`
  没人改写。下次启动 `recoverPendingTodosOnStartup()` 里多条「放弃恢复」分支只把
  `todo.status` 改回 `'todo'`，**不动 `aiSession.status`**，僵尸就此诞生。
- cursor 没有 claude 那种 jsonl-on-disk 的 sanity check，所以即使 cwd 已变 /
  进程已死，DB 里也仍可能停在 `running`——截图就是这个场景。

前端目前在 `FocusSubbar.tsx:61` 用 `fallbackStatus`（来自 todo 快照的 aiSession.status）
推导 pill 状态，僵尸 `running` 直接渲染成「运行中」，与同时显示的「恢复会话」按钮冲突。

## 目标

后端在启动期主动把所有"DB 里 alive 但没有对应 live PTY"的孤儿 aiSession 写成
`'failed'`，让前端读到的 status 始终自洽。前端零改动。

## 非目标

- 不引入新的视觉态。`deriveAiState` 不改，`'failed'` 仍推导为 pill 上的「空闲」。
  PTY 死了就死了，复用 idle pill 即可。
- 不处理"PTY 被外部 kill -9 但服务还活着"的运行期检测——需要 heartbeat / health
  probe，超出本次范围。
- 不改前端的 fallback 推导逻辑。后端正本清源后，DB 不再返 running，fallback
  自然走对路径；保留它作为 defense in depth。

## 设计

### 1. 新函数 `markOrphanedSessionsAsFailed()`

位置：`src/routes/ai-terminal.js`，与 `recoverPendingTodosOnStartup()` 同文件。

行为：

```text
for todo in db.listTodos():
  changed = false
  next = []
  for s in todo.aiSessions || []:
    if s.status in {'running', 'idle', 'pending_confirm'}:
      key = `${s.tool}:${s.nativeSessionId}`
      if s.nativeSessionId && nativeSessionMap.has(key):
        # live PTY 真的活着（成功 recover / 正在运行的 idle 会话），跳过
        next.push(s)
        continue
      next.push({ ...s, status: 'failed', completedAt: Date.now() })
      changed = true
    else:
      next.push(s)
  # 兼容旧 schema：todo.aiSession 单字段也按同样规则处理
  nextSingle = todo.aiSession
  if nextSingle && nextSingle.status in {'running', 'idle', 'pending_confirm'}:
    key = `${nextSingle.tool}:${nextSingle.nativeSessionId}`
    if !(nextSingle.nativeSessionId && nativeSessionMap.has(key)):
      nextSingle = { ...nextSingle, status: 'failed', completedAt: Date.now() }
      changed = true
  if changed:
    db.updateTodo(todo.id, { aiSessions: next, aiSession: nextSingle })
    sweptCount += 1
console.log(`[ai-terminal] orphan sweep: marked ${sweptCount} sessions as failed`)
```

注意点：

- **必须** 在 `recoverPendingTodosOnStartup()` **之后**调用。成功 recover 的 session
  此时已经被该函数写回 `status='running'`（line 1300-1311）+ 进了
  `nativeSessionMap`（line 1299），扫描会自动跳过。
- `completedAt` 用 `Date.now()` 而不是某个推断的过去时间——我们不知道 PTY 实际
  何时死的，但 DB 里这条记录"被识别为已结束"是现在。
- 不要清掉 `nativeSessionId`：保留它，让用户后续仍可点「恢复会话」拉一条新 PTY。

### 2. `recoverPendingTodosOnStartup()` 内的 catch 路径补写

`src/routes/ai-terminal.js` 当前两处「放弃恢复」分支只更新 `todo.status='todo'`：

- line 1326-1333：`pty.start(...).catch(...)` —— spawn 异步失败
- line 1334-1340：`try/catch` —— spawn 同步抛错

两处都补一笔：把对应那条 aiSession 的 status 写成 `'failed'`、`completedAt=Date.now()`。

实现细节：catch 块拿得到本次 recover 闭包里新生成的 `sessionId`（line 1269）
和 `todo.id`。注意 `recoverPendingTodosOnStartup` 在 spawn **之前**就已经
`mergeTodoAiSessions` 把 recoverable 那条的 sessionId 改写成了新值（line 1304），
所以 DB 里此时定位条目要用**新 sessionId**：再 `db.getTodo` 一次拿最新 aiSessions，
找 `s.sessionId === <新 sessionId>` 那条改写为 `{ ...s, status: 'failed',
completedAt: Date.now() }`，其它保留。

与 1 互为冗余：1 是启动后的一次性兜底，2 是单点 catch 的就地修复。即使 1 因为
任何原因没跑，2 仍能让单次失败的 recover 留下正确的 status。

### 3. 启动序列

`src/routes/ai-terminal.js:1374-1376` 末尾调用顺序改为：

```js
sweepStuckPendingConfirm()
recoverPendingTodosOnStartup()
markOrphanedSessionsAsFailed()  // 新增
```

`recoverPendingTodosOnStartup` 内 spawn 是 async 的，`pty.start(...).catch(...)`
不会阻塞同步调用流；但 spawn 失败 catch 写 aiSession.status='failed' 这一步是
独立于扫描的，两者互不依赖。扫描跑的时候，成功 spawn 已经 set 了
nativeSessionMap，扫描会跳过——这一点是时序安全的。

### 4. 前端

零改动。

`FocusSubbar.tsx:61` 的 `fallbackStatus='failed'` 经
`deriveAiState('failed', unread, false)` 推导为 `'idle'`，pill 渲染为
「{tool} · 空闲」，与「恢复会话」按钮共存不再矛盾。

顶栏 `useDispatchStats.ts:55-66` 的 running 兜底逻辑里 `deriveAiState` 也会把
`'failed'` 算作非 running、非 idle（因为前面已 `isClosedAiStatus` 排除），不会
进入任何计数。

## 验收标准

1. **核心场景**：模拟硬重启——DB 里某 todo 的 aiSession 是 `status='running'` 且
   `nativeSessionMap` 中无对应条目——后端启动完成后，该 aiSession 在 DB 中变为
   `status='failed'`，`completedAt` 非空。前端 SessionFocus 不再显示「运行中」pill。
2. **idle 孤儿也清**：DB 里 `status='idle'` 且无 live PTY 的 aiSession，启动后变为
   `'failed'`。
3. **pending_confirm 孤儿也清**：同上。
4. **成功 recover 不被误伤**：claude session 文件仍在、recover 成功的 session，
   启动后 status 保持 `'running'`，未被写为 `'failed'`。
5. **正常退出路径未变**：用户主动 stop 一个 running session，aiSession.status
   变为 `'stopped'`；自然 exit code 0 变为 `'done'`。与现状一致。
6. **spawn 失败 catch 补写**：构造一个 `pty.start` 抛错的 recover 流程，断言
   该 aiSession 的 status 在 catch 后变为 `'failed'`。
7. **顶栏 running 计数不再含僵尸**（间接验收——DB 不再返 running，前端 fallback
   不会再把孤儿算进 running）。
8. 现有 vitest 全绿。

## 测试

- **新增 unit test** `test/ai-terminal-orphan-sweep.test.js`：
  - 构造一个 todo with `aiSessions: [{ sessionId, tool, nativeSessionId,
    status: 'running' }]`，`nativeSessionMap` 为空 → 调用
    `markOrphanedSessionsAsFailed()` → 断言 DB 里 status 变为 `'failed'`。
  - 同上但 nativeSessionMap 含 `${tool}:${nativeSessionId}` → 断言保留
    `'running'`。
  - 三种 alive 状态（running / idle / pending_confirm）都覆盖一遍。
  - `done` / `failed` / `stopped` 的 session 不被改写。
- **现有 vitest 全跑一遍**：`test/config.test.js` 等不应被影响。

## 风险与回滚

- **风险**：扫描如果误把 alive session 改成 failed，用户会觉得 session 莫名
  消失。**缓解**：扫描依赖 `nativeSessionMap` 这个 in-memory 数据，启动顺序保证
  recover 先跑、nativeSessionMap 先填好；测试用例显式覆盖 alive 跳过路径。
- **回滚**：单文件改动 + 单文件新测试，回滚只需 revert 一个 commit。
