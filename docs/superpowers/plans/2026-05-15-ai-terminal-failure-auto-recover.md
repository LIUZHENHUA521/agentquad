# AI Terminal 失败路径自动恢复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude/Codex PTY 非 0 退出时，前端自动 resume 3 次（退避 1s/3s/8s），失败后复用现有 `sessionExpired` 工具栏 UI，让用户不再被"假活的"TUI 卡死。

**Architecture:** 后端零改动 —— `src/routes/ai-terminal.js:475` 已经把 `aiStatus` 映射成 `'failed'`/`'stopped'`/`'done'` 推到 WS。前端在 `case 'done'` 分流：`'failed'` 触发 `runWithBackoff` 重试循环（提取到独立的纯函数 `web/src/aiTerminalRecovery.ts`，方便 vitest 单测），`'stopped'` 不触发恢复（用户主动停止），`'done'` 不变。重试期间写黄色"正在自动恢复"横幅，全部失败后写红色横幅并把工具栏的 `sessionExpired` UI 复用出来。

**Tech Stack:** TypeScript · React (web/) · vitest · zustand · xterm · react-i18next

关联 spec：`docs/superpowers/specs/2026-05-15-ai-terminal-failure-auto-recover-design.md`

---

## File Structure

| 文件 | 状态 | 职责 |
|------|------|------|
| `web/src/aiTerminalRecovery.ts` | **新建** | 纯函数 `runWithBackoff`：按退避数组循环调用 `recover`，可取消，可注入自定义 sleep（测试用） |
| `test/ai-terminal-recovery.test.ts` | **新建** | vitest 单测，覆盖成功/失败/取消三类路径 |
| `web/src/i18n/locales/zh-CN.ts` | 修改 | 在 `session.terminal.writeln` 下加 `autoRecoverAttempt` / `autoRecoverGiveUp` |
| `web/src/i18n/locales/en-US.ts` | 修改 | 同上，英文 |
| `web/src/AiTerminalMini.tsx` | 修改 | 引入 `runWithBackoff`；重构 `case 'done'`；改 `tryAutoRecover` 语义；扩工具栏渲染条件 |

不动后端。

---

## Task 1: 添加 i18n 文案

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（在 `session.terminal.writeln` 块内，约 408-416 行附近）
- Modify: `web/src/i18n/locales/en-US.ts`（对应 `session.terminal.writeln` 块）

- [ ] **Step 1: 中文文案**

打开 `web/src/i18n/locales/zh-CN.ts`，定位到 `session.terminal.writeln` 对象。`Read` 这个文件确认现有 keys（`autoRecovering` / `autoRecoverFailedTool` / `autoRecoverFailedReason` 等）。

在 `aiTaskFailed: '任务失败',` 之后插入：

```ts
        autoRecoverAttempt: '检测到会话异常退出 (exit {{code}})，正在自动恢复 ({{attempt}}/{{max}})...',
        autoRecoverGiveUp: '自动恢复 {{max}} 次均失败，请手动操作',
```

- [ ] **Step 2: 英文文案**

打开 `web/src/i18n/locales/en-US.ts`，定位到对应的 `session.terminal.writeln` 块（找 `aiTaskFailed: 'Task failed',`）。

在 `aiTaskFailed` 之后插入：

```ts
        autoRecoverAttempt: 'AI session exited unexpectedly (exit {{code}}). Auto-recovering ({{attempt}}/{{max}})...',
        autoRecoverGiveUp: 'Auto-recover failed after {{max}} attempts. Please recover manually.',
```

- [ ] **Step 3: 验证 TypeScript 编译通过**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误（如果 i18n key 类型是 inferred 自 zh-CN，加了新 key 后 en-US 也要有，已经做了）

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "i18n: add auto-recover attempt/giveup messages for AI terminal"
```

---

## Task 2: 写 `runWithBackoff` 失败测试

**Files:**
- Create: `test/ai-terminal-recovery.test.ts`

- [ ] **Step 1: 写 5 条测试，全部期待"模块不存在"而失败**

创建 `test/ai-terminal-recovery.test.ts`，写入：

```ts
import { describe, it, expect, vi } from 'vitest'
import { runWithBackoff } from '../web/src/aiTerminalRecovery.ts'

describe('runWithBackoff', () => {
  it('returns "recovered" when recover succeeds on first attempt', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValueOnce(true)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      sleep,
    })

    expect(outcome).toBe('recovered')
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it('keeps retrying with each backoff and reports attempt index', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      sleep,
    })

    expect(outcome).toBe('recovered')
    expect(recover.mock.calls.map(c => c[0])).toEqual([1, 2, 3])
    expect(sleep.mock.calls.map(c => c[0])).toEqual([10, 20, 30])
  })

  it('returns "exhausted" after all attempts fail', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValue(false)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      sleep,
    })

    expect(outcome).toBe('exhausted')
    expect(recover).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('returns "cancelled" before any attempt when isCancelled is true upfront', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValue(true)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      isCancelled: () => true,
      sleep,
    })

    expect(outcome).toBe('cancelled')
    expect(recover).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('returns "cancelled" mid-loop and skips remaining attempts', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValue(false)
    let cancelAfter = 1
    const isCancelled = vi.fn(() => recover.mock.calls.length >= cancelAfter)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      isCancelled,
      sleep,
    })

    expect(outcome).toBe('cancelled')
    expect(recover).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 运行测试，确认全部 FAIL（模块缺失）**

```bash
npx vitest run test/ai-terminal-recovery.test.ts
```

Expected: 全部 5 条 FAIL，错误信息含 `Failed to load url ../web/src/aiTerminalRecovery.ts` 或 `Cannot find module`。

- [ ] **Step 3: Commit failing tests**

```bash
git add test/ai-terminal-recovery.test.ts
git commit -m "test: add failing tests for AI terminal recovery backoff loop"
```

---

## Task 3: 实现 `runWithBackoff`

**Files:**
- Create: `web/src/aiTerminalRecovery.ts`

- [ ] **Step 1: 写最小实现**

创建 `web/src/aiTerminalRecovery.ts`：

```ts
/**
 * 失败重试编排：按 backoffMs 数组依次等待→调用 recover()。
 * 任意一次返回 true 即视为恢复成功；isCancelled 在每次 sleep 前后都检查一次，
 * 用于组件 unmount / 用户主动关闭终端时立刻退出循环。
 *
 * 注入式 sleep 让单测可以零等待跑完三次循环。
 */

export type RecoveryOutcome = 'recovered' | 'cancelled' | 'exhausted'

export interface RunWithBackoffOpts {
  backoffMs: number[]
  recover: (attempt: number) => Promise<boolean>
  isCancelled?: () => boolean
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runWithBackoff(opts: RunWithBackoffOpts): Promise<RecoveryOutcome> {
  const sleep = opts.sleep ?? defaultSleep
  const isCancelled = opts.isCancelled ?? (() => false)

  for (let i = 0; i < opts.backoffMs.length; i++) {
    if (isCancelled()) return 'cancelled'
    await sleep(opts.backoffMs[i])
    if (isCancelled()) return 'cancelled'

    const ok = await opts.recover(i + 1)
    if (ok) return 'recovered'
  }
  return 'exhausted'
}
```

- [ ] **Step 2: 跑测试，确认 5 条全部 PASS**

```bash
npx vitest run test/ai-terminal-recovery.test.ts
```

Expected: 5 PASS。

- [ ] **Step 3: Commit**

```bash
git add web/src/aiTerminalRecovery.ts
git commit -m "feat: add runWithBackoff helper for AI terminal failure recovery"
```

---

## Task 4: 重构 `tryAutoRecover` 的 attempted 语义

**Files:**
- Modify: `web/src/AiTerminalMini.tsx:224-266`（`tryAutoRecover` 函数体）

**为什么先改这个**：当前 `recoveryAttemptedRef` 在函数入口就被 set，导致失败后再调用直接 short-circuit return。3 次重试需要它只在成功时才置位；同时这一改动也修复了"自动恢复失败一次后手动『恢复会话』按钮按了无效"这个旧 bug。

- [ ] **Step 1: 编辑 `tryAutoRecover`**

定位 `web/src/AiTerminalMini.tsx:224-266`。把：

```ts
  const tryAutoRecover = useCallback(async () => {
    const latestResumeTarget = resumeTargetRef.current
    if (!latestResumeTarget?.nativeSessionId || recoveringRef.current || recoveryAttemptedRef.current) return false
    recoveringRef.current = true
    recoveryAttemptedRef.current = true
    try {
      termRef.current?.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.autoRecovering')} ---\x1b[0m\r`)
```

改成：

```ts
  const tryAutoRecover = useCallback(async () => {
    const latestResumeTarget = resumeTargetRef.current
    if (!latestResumeTarget?.nativeSessionId || recoveringRef.current || recoveryAttemptedRef.current) return false
    recoveringRef.current = true
    try {
      termRef.current?.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.autoRecovering')} ---\x1b[0m\r`)
```

（删除 `recoveryAttemptedRef.current = true`）

紧接着，定位到 `try` 块内 `startAiExec` 调用之后的成功路径（约 244 行附近，`stopReconnectRef.current = true` 之后）。在 `return true` 之前补一行 `recoveryAttemptedRef.current = true`：

```ts
      stopReconnectRef.current = true
      setSessionExpired(false)
      setToolMissing(null)
      onSessionRecoveredRef.current?.(nextSessionId)
      onSessionSwitchRef.current?.(nextSessionId)
      useDispatchStore.getState().signal('refreshTodos')
      recoveryAttemptedRef.current = true
      return true
```

- [ ] **Step 2: 运行后端测试，确认未误伤其他模块**

```bash
npx vitest run
```

Expected: 全部已有测试 PASS（这步只动了前端 useCallback，后端测试不会跑到这里，但作为 sanity check 跑一遍）。

- [ ] **Step 3: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "refactor(AiTerminalMini): set recoveryAttempted only on successful recover

让多次手动「恢复会话」 / 自动重试循环都不会被旧的失败记录卡住。"
```

---

## Task 5: 在 `case 'done'` 分流并接入自动恢复循环

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`（顶部 import、常量区、组件内）

- [ ] **Step 1: 加 import 与常量**

在文件顶部 import 区（约 22 行附近，`useAppConfigStore` 之后）加：

```ts
import { runWithBackoff } from './aiTerminalRecovery'
```

在常量区（`HEARTBEAT_INTERVAL` 之后，约 68 行附近）加：

```ts
// 失败路径自动恢复退避：1s → 3s → 8s（共 3 次）
const FAILURE_RECOVERY_BACKOFF_MS = [1000, 3000, 8000]
```

- [ ] **Step 2: 加 `sessionFailed` state 与 reset**

定位 `const [sessionExpired, setSessionExpired] = useState(false)`（约 155 行）。在它下面加：

```ts
  const [sessionFailed, setSessionFailed] = useState(false)
```

定位 mount effect 里的 `setSessionExpired(false)`（约 378 行）。在它下面加：

```ts
    setSessionFailed(false)
```

- [ ] **Step 3: 加 `startFailureAutoRecover` 函数**

紧接 `tryAutoRecover` useCallback 之后（约 266 行之后），新增：

```ts
  const startFailureAutoRecover = useCallback(async (exitCode: number) => {
    const term = termRef.current
    // 没有可 resume 的目标 → 直接显示最终失败 UI
    if (!resumeTargetRef.current?.nativeSessionId) {
      setSessionFailed(true)
      term?.writeln(`\r\n\x1b[31m=== ${t('session:terminal.writeln.aiTaskFailed')} ===\x1b[0m\r`)
      return
    }
    if (recoveringRef.current) return // 已有 4004 路径在 recover，让它跑

    const outcome = await runWithBackoff({
      backoffMs: FAILURE_RECOVERY_BACKOFF_MS,
      isCancelled: () => disposedRef.current,
      recover: async (attempt) => {
        if (disposedRef.current) return false
        term?.writeln(`\r\n\x1b[33m--- ${t('session:terminal.writeln.autoRecoverAttempt', {
          code: exitCode,
          attempt,
          max: FAILURE_RECOVERY_BACKOFF_MS.length,
        })} ---\x1b[0m\r`)
        return await tryAutoRecover()
      },
    })

    if (disposedRef.current) return

    if (outcome === 'exhausted') {
      setSessionFailed(true)
      term?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.autoRecoverGiveUp', {
        max: FAILURE_RECOVERY_BACKOFF_MS.length,
      })} ---\x1b[0m\r`)
      term?.writeln(`\r\n\x1b[31m=== ${t('session:terminal.writeln.aiTaskFailed')} ===\x1b[0m\r`)
    }
    // 'recovered' / 'cancelled' → 不写额外内容（recover 内部已 setSessionExpired(false) 等）
  }, [tryAutoRecover, t])
```

- [ ] **Step 4: 改 `case 'done'` 分流**

定位 `case 'done':`（约 696-700 行）。把：

```ts
              case 'done':
                setSessionStatus(msg.status === 'done' ? 'ai_done' : 'todo')
                term.writeln(`\r\n\x1b[${msg.exitCode === 0 ? '32' : '31'}m=== ${msg.status === 'done' ? t('session:terminal.writeln.aiTaskDone') : t('session:terminal.writeln.aiTaskFailed')} ===\x1b[0m\r`)
                onDone?.({ status: msg.status, exitCode: msg.exitCode })
                break
```

改成：

```ts
              case 'done':
                if (msg.status === 'done') {
                  setSessionStatus('ai_done')
                  term.writeln(`\r\n\x1b[32m=== ${t('session:terminal.writeln.aiTaskDone')} ===\x1b[0m\r`)
                  onDone?.({ status: msg.status, exitCode: msg.exitCode })
                } else if (msg.status === 'stopped') {
                  // 用户主动 stop：route 已经 broadcast 过 type:'stopped' 黄色"已中止"横幅，
                  // 这里只更状态、回调，不再追加红色"任务失败"，也不触发自动恢复。
                  setSessionStatus('todo')
                  onDone?.({ status: msg.status, exitCode: msg.exitCode })
                } else {
                  // 'failed'：先把 status 切到 todo + 回调（保持现状），然后进入自动恢复循环
                  setSessionStatus('todo')
                  onDone?.({ status: msg.status, exitCode: msg.exitCode })
                  void startFailureAutoRecover(msg.exitCode ?? 1)
                }
                break
```

- [ ] **Step 5: 类型检查**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(AiTerminalMini): auto-recover claude/codex non-zero exits with backoff retry

WS 'done' status='failed' 触发 3 次退避重试 (1s/3s/8s)，全部失败后写
红色横幅；status='stopped' 不触发恢复，沿用现有'已中止'路径；
status='done' 行为不变。"
```

---

## Task 6: 失败兜底复用 `sessionExpired` 工具栏 UI

**Files:**
- Modify: `web/src/AiTerminalMini.tsx`（约 1241-1263 行附近，工具栏渲染区 + handleManualRecover）

- [ ] **Step 1: 扩工具栏渲染条件**

定位 `web/src/AiTerminalMini.tsx:1241-1263`，把三处 `sessionExpired &&` 改为 `(sessionExpired || sessionFailed) &&`：

```tsx
        {(sessionExpired || sessionFailed) && (
          <Tag color="error" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>
            {t('session:terminal.toolbar.sessionExpired')}
          </Tag>
        )}
        {(sessionExpired || sessionFailed) && resumeTargetRef.current?.nativeSessionId && (
          <Button
            size="small"
            onClick={handleManualRecover}
            style={{ height: 22, paddingInline: 8 }}
          >
            {t('session:terminal.toolbar.recoverSession')}
          </Button>
        )}
        {(sessionExpired || sessionFailed) && (
          <Button
            size="small"
            onClick={onClose}
            style={{ height: 22, paddingInline: 8 }}
          >
            {t('session:terminal.toolbar.close')}
          </Button>
        )}
```

- [ ] **Step 2: 改 `handleManualRecover` 让它能反复点**

定位 `web/src/AiTerminalMini.tsx:1075-1080`。把：

```ts
  const handleManualRecover = useCallback(async () => {
    const recovered = await tryAutoRecover()
    if (!recovered) {
      termRef.current?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.noNativeSessionId')} ---\x1b[0m\r`)
    }
  }, [tryAutoRecover])
```

改成：

```ts
  const handleManualRecover = useCallback(async () => {
    // 自动恢复失败 / 上一次手动恢复失败后，recoveryAttemptedRef 仍是 false（只在成功路径置位），
    // 但 4004 路径触发过一次成功 recover 后再失效时，需要让用户能再点一次：reset 它。
    recoveryAttemptedRef.current = false
    const recovered = await tryAutoRecover()
    if (recovered) {
      setSessionFailed(false)
    } else {
      termRef.current?.writeln(`\r\n\x1b[31m--- ${t('session:terminal.writeln.noNativeSessionId')} ---\x1b[0m\r`)
    }
  }, [tryAutoRecover])
```

- [ ] **Step 3: 类型检查**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: 全量构建**

```bash
cd web && npm run build
```

Expected: build 成功，无新警告（pre-existing chunk size 警告除外）。

- [ ] **Step 5: Commit**

```bash
git add web/src/AiTerminalMini.tsx
git commit -m "feat(AiTerminalMini): expose manual recover toolbar UI on failure path

工具栏的「恢复会话」「关闭」按钮渲染条件加上 sessionFailed，复用现有
sessionExpired 那套样式（红 Tag + 两按钮），与 4004 路径像素级一致。
handleManualRecover 在调用前 reset recoveryAttemptedRef，让按钮能反复点。"
```

---

## Task 7: 手动 UI 验收

**Files:** 无（启动 dev server 走真实交互）

- [ ] **Step 1: 启动 dev**

```bash
npm start
```

在浏览器打开 `http://localhost:3000`（或日志里的端口）。

- [ ] **Step 2: 验收"正常完成"路径不变**

1. 创建一个 todo，启动一个轻量 claude 任务（比如 prompt 让它输出一行就退出）
2. 等任务自然完成 → 期待绿色 `=== AI 任务已结束 ===`
3. 工具栏出现「待验收」黄色 Tag
4. **不**出现红色 `会话已失效` Tag、**不**出现「恢复会话」按钮
5. ✅ 通过 → 继续

- [ ] **Step 3: 验收"主动停止"路径不变**

1. 启动一个长任务，运行中点工具栏的「停止」按钮
2. 期待黄色 `=== 已中止 ===`
3. **不**应触发自动恢复，**不**出现红色 `=== 任务失败 ===`
4. ✅ 通过 → 继续

- [ ] **Step 4: 验收"失败 → 自动恢复成功"路径**

构造一个易失败场景：通过 `kill <pid>` 直接杀掉 claude 进程（在 Activity Monitor / `ps aux | grep claude` 找到对应 pid）。

1. 启动一个长任务
2. 找到底层 claude pid，`kill <pid>`（默认 SIGTERM）
3. 期待终端写出黄色 `检测到会话异常退出 (exit ...)，正在自动恢复 (1/3)...`
4. 1 秒后 `tryAutoRecover` 触发；如果后端 resume 成功，应该静默切到新 sessionId，重新进入 ai_running
5. **不**出现 `=== 任务失败 ===` 红字、**不**出现 `会话已失效` Tag
6. ✅ 通过 → 继续

- [ ] **Step 5: 验收"3 次自动恢复全部失败"路径**

构造一个稳定失败场景：在恢复瞬间 mock 后端 503（最简单：临时把 `src/routes/ai-terminal.js` 里 `startAiExec` 路由对应的 handler 加一行 `return res.status(503).json({ ok: false, error: 'mock' })`，验完恢复）。

或者更轻：直接把 `web/src/api.ts` 里的 `startAiExec` 临时改成抛错。

1. 启动长任务，杀进程触发失败
2. 期待依次写出：
   - `检测到会话异常退出 (exit X)，正在自动恢复 (1/3)...` → 1s 后失败
   - `自动恢复失败：mock` (现有 `autoRecoverFailedReason` 文案)
   - `检测到会话异常退出 ... (2/3)...` → 3s 后失败 → 同上
   - `检测到会话异常退出 ... (3/3)...` → 8s 后失败 → 同上
   - `自动恢复 3 次均失败，请手动操作`
   - 红色 `=== 任务失败 ===`
3. 工具栏出现红色 `会话已失效` Tag + 「恢复会话」 + 「关闭」按钮（与现有 4004 路径像素一致）
4. 点「恢复会话」 → 走 manual recover；如果后端恢复（mock 已撤销），应进入 ai_running
5. ✅ 通过 → 撤销后端 mock

- [ ] **Step 6: 验收 `sessionExpired`（4004 路径）也没坏**

1. 启动任务，到后端 kill server（`pkill -f 'node src/cli.js'`）然后立刻重启
2. 前端 WS 收到 4004 → 走原 4004 path → tryAutoRecover → 失败的话也应进入红 Tag + 按钮
3. ✅ 通过

- [ ] **Step 7: Commit 任何 dev 验证中发现的小修**

如果验收中没发现需要修的，跳过此 commit。如果有，单独 commit 一次。

---

## Self-Review

**1. Spec coverage:**
- §3.2 触发与短路 → Task 5 step 4 (case 'done' 分流) + Task 5 step 3 (`startFailureAutoRecover` 内 short-circuit)
- §3.3 重试循环 + 退避 → Task 2/3 (runWithBackoff) + Task 5 (FAILURE_RECOVERY_BACKOFF_MS)
- §3.4 改造 tryAutoRecover → Task 4
- §3.5 失败 UI 复用 sessionExpired → Task 6
- §3.6 i18n → Task 1
- §3.7 取消 → Task 5 step 3 (`isCancelled: () => disposedRef.current` + post-loop guard)
- §6 验收 1-6 → Task 7
- §6 验收 7 (单测) → Task 2/3 覆盖 runWithBackoff 的核心循环逻辑（React 组件本身无单测基础设施，spec 提到的"模拟 WS 收到 done"只能通过手动验收，已在 Task 7 step 4-5 覆盖）

**2. Placeholder scan:** 无 TBD/TODO/"详见后续"。所有代码块都是完整可贴的内容。Task 7 step 5 的"临时 mock"明确写了两种实现方式，不算占位。

**3. Type consistency:**
- `runWithBackoff` 签名在 Task 2 测试和 Task 3 实现中一致：`{ backoffMs, recover, isCancelled?, sleep? }`
- `RecoveryOutcome` 三态 `'recovered' | 'cancelled' | 'exhausted'` 在 Task 2/3/5 中一致引用
- `sessionFailed` state 类型 `boolean`，setter 名 `setSessionFailed`，全程一致
- `FAILURE_RECOVERY_BACKOFF_MS.length === 3`，所有"max=3"的引用都从这个常量取
- i18n key `autoRecoverAttempt` / `autoRecoverGiveUp` 在 Task 1（定义）和 Task 5（使用）中拼写一致

---

## Open Questions

无。所有决策已在 spec 与之前对话中拍板。

---

## 不在范围

- 后端协议扩 `signal` / `tailLog` 字段（B 方案，留待后续单独 PR）
- 自动恢复成功后给用户"刚才那一步可能未完成"的提示
- 跨 mount 周期的失败计数 / 熔断
