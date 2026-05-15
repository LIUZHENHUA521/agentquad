# 跨端用户输入镜像（PC ↔ Telegram ↔ Lark）

**日期**：2026-05-15
**状态**：设计已确认，待写实施计划

## 背景

AgentQuad 给每个 todo 绑一个 Claude / Codex PTY，用户可从三个入口给同一 session 发消息：

| 入口 | 写入 PTY 路径 |
|---|---|
| PC web UI | `routes/ai-terminal.js` 的 `handleBrowserMessage` (WS `type:'input'`) / `writeRestInputToPty` (`POST /input`)，直接 `pty.write` |
| Telegram | `telegram-bot.js` → `openclaw-wizard.js` → `sessionInputDispatcher.send({ channel: 'telegram', ... })` |
| Lark | `lark-bot.js` → `openclaw-wizard.js` → `sessionInputDispatcher.send({ channel: 'lark', ... })` |

Agent 的回复经 Claude 的 `Stop` hook（`templates/claude-hooks/notify.js` → `/api/openclaw/hook` → `openclaw-hook.js`）读 transcript 末尾 assistant turn，再通过 `openclawBridge.postText` 推到当前绑定的 IM thread。

**问题**：从 PC 输入时，文本直接落到 PTY，没有任何环节把用户提问回放到 IM。用户在手机上只看到突然冒出来的 AI 回复，缺上下文。

## 目标

把所有渠道的用户提问镜像到其他已绑定的 IM thread：

- PC 提交 → Telegram + Lark 各收一条 `👤 <prompt>`。
- Telegram 提交 → Lark 收一条 `👤 <prompt>`（Telegram 自己不重复）。
- Lark 提交 → Telegram 收一条 `👤 <prompt>`（Lark 自己不重复）。

Claude 和 Codex 两类 session 都要支持。

## 方案

新增 `UserPromptSubmit` hook，跟现有 Stop / SessionEnd / Notification 共用 `notify.js` → `/api/openclaw/hook` 链路。Hook 触发时从 payload 拿 `user_prompt`，dispatcher 侧用一张 30s TTL 的去重表识别 origin channel，bridge 侧广播到所有非 origin 的已绑路由。

## 组件

### 1. Hook 安装层

**`src/openclaw-hook-installer.js`**：

```js
// 之前
const HOOK_EVENTS = ['Stop', 'Notification', 'SessionEnd']
// 之后
const HOOK_EVENTS = ['Stop', 'Notification', 'SessionEnd', 'UserPromptSubmit']

function buildHookEntry(event, hookScriptPath) {
  const eventLower =
    event === 'SessionEnd' ? 'session-end' :
    event === 'Notification' ? 'notification' :
    event === 'UserPromptSubmit' ? 'user-prompt-submit' :
    'stop'
  // ...
}
```

**`src/codex-hook-installer.js`**：

```js
// 之前
const eventLower = event === 'UserPromptSubmit' ? 'notification' : 'stop'
// 之后
const eventLower = event === 'UserPromptSubmit' ? 'user-prompt-submit' : 'stop'
```

**`src/templates/claude-hooks/notify.js`**：版本号 `quadtodo-hook-version: 2` → `3`，迫使 installer 在用户下次 `agentquad start` 时把 hook 脚本重新下发（已有版本比对逻辑）。脚本本体不动。

### 2. Hook 事件分发

**`src/openclaw-hook.js`**：

新增 case 分支（在现有 `switch (evt)` 内，与 `'stop' / 'notification' / 'session-end'` 平级）：

```js
case 'user-prompt-submit':
  return handleUserPromptSubmit({
    sessionId,          // ENV QUADTODO_SESSION_ID
    hookPayload,        // { user_prompt: '...', session_id, transcript_path, ... }
    aiTerminal,
    openclaw,
    db,
    sessionInputDispatcher,
    logger,
  })
```

`handleUserPromptSubmit` 步骤：

1. 从 `hookPayload.user_prompt`（Claude）或 `hookPayload.prompt` / `hookPayload.user_message`（Codex，实现时探测确认）取文本。
2. 文本 trim 后为空 → 静默退出。
3. `const origin = sessionInputDispatcher.consumeOrigin(sessionId, prompt)` → 拿到 origin channel 或 `null`。
4. 文本截断：长度 > 2000 → 取前 2000 + `'\n… [共 N 字]'`。
5. 组装：`const echoMessage = '👤 ' + truncated`。
6. `await openclaw.broadcastEcho({ sessionId, message: echoMessage, excludeChannel: origin })`。
7. 失败一律静默（warn log），不抛。

### 3. 去重表（dispatcher 侧）

**`src/session-input-dispatcher.js`** 新增：

```js
import { createHash } from 'node:crypto'

const ORIGIN_TTL_MS = 30_000
const ORIGIN_LIMIT = 16  // 每 session 最多保留的 origin record 数

const lastOrigins = new Map() // sessionId → Array<{ hash, channel, ts }>

function normalizeAndHash(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ')
  return createHash('sha1').update(normalized).digest('hex')
}

function recordOrigin(sessionId, text, channel) {
  if (!sessionId || !text || !channel) return
  const now = Date.now()
  const arr = (lastOrigins.get(sessionId) || [])
    .filter(e => now - e.ts < ORIGIN_TTL_MS)
    .slice(-(ORIGIN_LIMIT - 1))
  arr.push({ hash: normalizeAndHash(text), channel, ts: now })
  lastOrigins.set(sessionId, arr)
}

function consumeOrigin(sessionId, text) {
  if (!sessionId || !text) return null
  const arr = lastOrigins.get(sessionId)
  if (!arr || !arr.length) return null
  const h = normalizeAndHash(text)
  const now = Date.now()
  const idx = arr.findIndex(e => e.hash === h && now - e.ts < ORIGIN_TTL_MS)
  if (idx < 0) return null
  const { channel } = arr[idx]
  arr.splice(idx, 1)
  if (!arr.length) lastOrigins.delete(sessionId)
  return channel
}

// 暴露 API
return { send, hardCancel, softInterrupt, recordOrigin, consumeOrigin, /* ... */ }
```

调用点（所有把用户原文写进 PTY 的位置）：

- `send()` 的 `idle === true` 直发分支（line ~121）：写 PTY 前调 `recordOrigin(sessionId, stripped, channel)`。
- `performSoftInterrupt`：同上（soft interrupt 后立刻写 stripped）。
- `flush()`（line ~211 附近）：每个 item flush 时单独 record（用 item 自带的 channel）。
- `enqueue()` 里把 `channel` 也存进 item：`q.items.push({ text, imagePaths, channel, enqueuedAt })`。

`channel` 取值：dispatcher.send 的 caller 传过来的，目前只有 `'telegram'` 和 `'lark'`。

### 4. 路由查询（bridge 侧依赖）

**`src/openclaw-bridge.js`** 构造参数新增 `getRoutesForSession`：

```js
export function createOpenClawBridge({ /* ... */, getRoutesForSession = null } = {}) {
  // ...
  async function broadcastEcho({ sessionId, message, excludeChannel } = {}) {
    if (!sessionId || !message || !getRoutesForSession) {
      return { skipped: true, reason: 'missing_deps_or_args' }
    }
    if (!rateLimitOk()) return { skipped: true, reason: 'rate_limited' }

    const { telegram: tg, lark: lk } = getRoutesForSession(sessionId) || {}
    const results = { telegram: null, lark: null }

    if (tg?.threadId && excludeChannel !== 'telegram') {
      const token = getTelegramTokenFromConfig(getConfig())
      if (token) {
        results.telegram = await sendViaTelegramAPI({
          token,
          chatId: String(tg.targetUserId),
          threadId: tg.threadId,
          text: message,
          logger,
        })
        if (results.telegram?.ok) recordSend()
      }
    }

    if (lk?.rootMessageId && excludeChannel !== 'lark' && larkBot?.replyInThread) {
      results.lark = await larkBot.replyInThread({
        rootMessageId: lk.rootMessageId,
        text: message,
      })
      if (results.lark?.ok) recordSend()
    }

    return results
  }

  return { /* ...existing... */, broadcastEcho }
}
```

**`src/server.js`** 给 bridge 构造时注入 `getRoutesForSession`：

```js
const openclawBridge = createOpenClawBridge({
  // ...
  getRoutesForSession: (sessionId) => {
    // 找 sessionId 对应的 todo + aiSession
    const todos = db.listTodos({ status: 'all', archived: 'all' }) || []
    for (const t of todos) {
      const ai = (t.aiSessions || []).find(s => s?.sessionId === sessionId)
      if (ai) {
        return {
          telegram: ai.telegramRoute || null,
          lark: ai.larkRoute || null,
        }
      }
    }
    return { telegram: null, lark: null }
  },
})
```

性能：list 全量 todos 的开销在用户量级（百级）可忽略；如有热点再加 LRU。

### 5. Hook handler 注入 dispatcher

**`src/server.js`**：`createOpenClawHookHandler` 调用处已经传了 `sessionInputDispatcher`，无需新增；只需在 hook handler 内部把它向下传到 `handleUserPromptSubmit`。

## 数据流

### PC 输入

```
浏览器 WS msg.type='input'
  → pty.write (no recordOrigin)
  → Claude TUI 提交
  → fires UserPromptSubmit
  → notify.js POSTs /api/openclaw/hook { event:'user-prompt-submit', hookPayload:{ user_prompt:'...' } }
  → openclaw-hook handleUserPromptSubmit
  → consumeOrigin(sid, prompt) → null
  → broadcastEcho({ excludeChannel: undefined })
  → Telegram + Lark 都收到 '👤 ...'
```

### Telegram 输入

```
Telegram message
  → wizard.handleInbound
  → dispatcher.send({ channel:'telegram', ... })
  → recordOrigin(sid, stripped, 'telegram')
  → pty.write
  → Claude TUI 提交
  → fires UserPromptSubmit
  → openclaw-hook
  → consumeOrigin(sid, prompt) → 'telegram'
  → broadcastEcho({ excludeChannel:'telegram' })
  → 只发 Lark
```

Lark 输入对称。

## 截断 & 文案规范

- 模板：`👤 <prompt>`（开头 emoji 区分 user / assistant；不加引号，避免 MarkdownV2 转义复杂化）。
- 截断：`raw.length > 2000` → `raw.slice(0, 2000) + '\n… [共 ' + raw.length + ' 字]'`。
- 空 prompt / 仅 whitespace：skip。
- Telegram 侧由 `sendViaTelegramAPI` 内 `toTelegramV2` 自动 escape。
- Lark 侧 `replyInThread` 接 plain text。

## 边界 & 失败模式

| 场景 | 行为 |
|---|---|
| 该 session 没绑任何 IM 路由 | 静默 skip |
| 只绑 Telegram，PC 输入 | 只发 Telegram |
| Telegram thread 已被关闭 / 删除 | Telegram API 报错 → log warn，Lark 仍正常 |
| Lark root message 已撤回 | `replyInThread` 返回 not-ok → 静默 drop（沿用现有语义） |
| Bridge rate limit 触发 | `broadcastEcho` 返回 `{ skipped:true, reason:'rate_limited' }`，本次 echo 丢弃 |
| Codex payload 字段不同 | 实现时验证；缺则 fallback 读 codex jsonl 末行 user turn |
| Hook fire 但 30s 内未触发去重表（PTY 卡） | 30s 后 consume 找不到，按 PC origin 处理 → origin 通道会多收一条；可接受（极少见）|
| 一次粘贴拆成 N 个 prompt submit | 每条都 fire UserPromptSubmit → 手机端看到 N 条 `👤`；可接受 |
| Wizard force-reply 触发的 user 输入 | 仍 echo（按用户决策 5：全部镜像）|

## 测试

### 单元测试

- `session-input-dispatcher.test.js`：
  - `recordOrigin` + `consumeOrigin` 命中（同文本、不同 channel 区分）。
  - 30s TTL 过期后 `consumeOrigin` 返回 null。
  - 归一化：trim、连续 whitespace 折叠匹配。
  - LIMIT 上限：超过 16 条后 FIFO 淘汰最老的。
  - dispatcher.send 写 PTY 时自动 recordOrigin（mock pty）。
- `openclaw-bridge.test.js`：
  - `broadcastEcho` 双路由全发。
  - `excludeChannel='telegram'` 只发 lark；`excludeChannel='lark'` 只发 telegram。
  - 单边路由缺失（只有 telegram 或只有 lark）正确处理。
  - `getRoutesForSession` 为 null 时返回 `skipped`。
- `openclaw-hook.test.js`：
  - `user-prompt-submit` 分支调用 broadcastEcho 时 excludeChannel 来自 consumeOrigin 返回值。
  - 长 prompt 截断格式正确。

### 手动验证

1. **PC → 双发**：启动 AgentQuad，挂 Telegram + Lark；从 PC web UI 提交 "hello" → 2s 内两个 thread 各收一条 `👤 hello`。
2. **Telegram → 单发 Lark**：从手机 Telegram 发 "from-tg"；Telegram 自然显示用户自己消息，bot 不重复；Lark 收 `👤 from-tg`。
3. **Lark → 单发 Telegram**：对称。
4. **长 prompt**：粘 3000 字 → 截断格式正确。
5. **关闭 Telegram topic 后**：echo 失败但 Lark 仍正常。
6. **Codex session**：切到 codex 工具，重复 PC 输入实验，验证 echo 工作（前提是 Codex UserPromptSubmit payload 含 prompt 文本；不含则 implementation 需补 fallback）。
7. **回归**：现有 Stop hook → assistant 回复仍正常推送；SessionEnd transcript 附件仍发送。

## 不在范围

- Web UI 端展示 IM thread（反向同步：IM 消息打到 web UI），不在本次。
- 历史消息回填（开 thread 时把已有对话补回去），不在本次。
- 多用户 / 多 chat 场景的 ACL：沿用现有"single owner"假设。
- Image / 文件附件的镜像：本次只镜像文本。

## 后续

后续可考虑：在 echo 消息里附 `[来自 PC]` / `[来自 Lark]` 这种 origin tag 辅助识别；视用户反馈再加。
