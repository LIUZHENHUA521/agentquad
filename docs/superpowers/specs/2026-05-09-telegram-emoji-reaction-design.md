# Telegram 用消息 reaction 表示 AI 状态

**日期**：2026-05-09
**状态**：已确认（方案 B）

## 背景

Lark 那边对"AI 在干活"这件事的提示，是直接在用户触发消息上加一个 emoji_type reaction
（`THINKING` / `OK`），等到 Claude Code 完成一轮回复（Stop hook）时把 reaction 删掉。
代码：`src/lark-bot.js`（pendingReactions Map） + `src/openclaw-hook.js:640-645`。

Telegram 这边目前不在用户消息上加 reaction，而是改 forum topic 的标题前缀
（`🔄/💤/✅/❌/⏹`），代码在 `src/telegram-loading-status.js`。这种方式有两个问题：

1. **节流压力大**：标题改名走 30s per-chat 节流 + 全局 429 backoff，频繁 idle ↔ running
   切换被节流挡掉，体验上"标题状态不可靠"。
2. **粒度错位**：标题是 topic 维度的全局状态，不是消息维度的 fine-grained 提示。
   用户在一个 topic 里发了 3 条消息触发了一轮回复，标题只能表达"现在 running"，
   但分不出哪 3 条是被 AI 处理掉的。

Telegram Bot API 7.0+ 已提供 `setMessageReaction`，且 `src/telegram-bot.js:326` 已实现
该方法。所需要做的是把它接到 openclaw session 生命周期上。

## 方案

**方案 B（已采纳）**：reaction 接管 running/idle，标题只保留终态前缀。

- **running**：用户触发消息上加 ✍ reaction（默认 emoji，可配置）
- **idle**：reaction 不动（与 Lark 一致；Stop hook 一次性清）
- **Stop hook**（一轮回复完成）：把这个 session 期间所有用户触发消息的 ✍ reaction 全清掉
- **session-end / 终态**：兜底再清一次 reaction；topic 标题保留 ✅/❌/⏹ 前缀

非终态（running/idle）的 topic 标题改名路径全部废掉，节流问题随之消失。
终态前缀仍走原 `telegram-loading-status.js`，因为 topic 列表全局视角靠它呈现。

## 模块拆分

### 新增 `src/telegram-reaction-tracker.js`

工厂函数 `createReactionTracker({ telegramBot, getConfig, logger })` 返回：

```
{
  noteUserMessage({ sessionId, chatId, messageId }) → Promise<void>
  clearReactionsForSession(sessionId) → Promise<{ ok, removed }>
  has(sessionId) → boolean
  size() → number
  __test__: { sessions }
}
```

**职责**：

- 维护 `sessionId → [{ chatId, messageId }]` 内部 Map（不存 reactionId，
  因为 Telegram setMessageReaction 是覆盖式 —— 清就是再调一次发空数组）。
- `noteUserMessage`：先把 (chatId, messageId) 追加进 list（同步 / 防 race），
  然后异步调 `telegramBot.setMessageReaction({ chatId, messageId, emoji: '✍' })`。
  失败 → log warn，不重试，不抛（cosmetic 标记掉了就掉了，不影响主流程）。
- `clearReactionsForSession`：取出 list、清空 Map entry，遍历调
  `setMessageReaction({ chatId, messageId, emoji: null })`（空数组等价清空）。
  失败 → log warn，不抛。

**配置**（读自 `getConfig().telegram`）：

| key | 默认 | 含义 |
|---|---|---|
| `reactionEnabled` | `true` | 总开关 |
| `reactionRunningEmoji` | `'✍'` | running 用哪个标准 emoji |

**emoji 选择风险**：Telegram supergroup 的 "Available Reactions" 设置可能过滤掉
非默认 emoji。✍ (U+270D U+FE0F) 在 Telegram 标准列表中。如果用户群里限制了
只允许部分 reaction，bot 调用会失败 —— 失败时降级（log warn + 该消息这轮不再尝试），
不卡主流程。把 emoji 做成可配置项，用户可以自己挑群里允许的（譬如 👀 / 🤔 / 👨‍💻）。

### 改造 `src/telegram-loading-status.js`

- 删 `start({ sessionId, skipTitleRename })` 内部的 `renameTopic(state, 'running')`
  调用（首次 🔄 不再加；sessions Map 维护逻辑保留，因为 stop 时还要查 originalTopicName）。
- `markIdle()` / `markRunning()` 改为 no-op（保留导出接口避免破坏 caller，但函数体直接 return）。
- `stop({ sessionId, finalStatus })` 维持原样：终态走 done/failed/stopped 标题前缀，
  保留全局 backoff 但不再受 per-chat 30s 节流（终态本来就硬上）。
- 文件头注释更新：从"根据 PTY session 生命周期改 telegram topic 标题前缀"
  改为"只在终态时改 topic 标题前缀（running/idle 由 reaction-tracker 处理）"。

### 改造 `src/telegram-bot.js dispatch()`

在 `wizard.handleInbound(...)` 返回后：

```js
if (result?.sessionId && reactionTracker) {
  reactionTracker.noteUserMessage({
    sessionId: result.sessionId,
    chatId,
    messageId: msg.message_id,
  }).catch((e) => logger.warn?.(`[telegram-bot] reaction note failed: ${e.message}`))
}
```

`createTelegramBot` 增加可选注入参数 `reactionTracker`（跟 loadingTracker 平行）。

### 改造 `src/openclaw-hook.js`

`evt === 'stop' || evt === 'session-end'` 的 lark 清 reaction 分支旁边，并联一份 telegram 的：

```js
if ((evt === 'stop' || evt === 'session-end') && sessionId && reactionTracker?.clearReactionsForSession) {
  const route = openclaw.resolveRoute?.(sessionId)
  if (route?.channel === 'telegram') {
    reactionTracker.clearReactionsForSession(sessionId)
      .catch((e) => logger.warn?.(`[openclaw-hook] tg clearReactionsForSession failed: ${e.message}`))
  }
}
```

`createOpenclawHook` 增加注入参数 `reactionTracker`（跟 `larkBot` / `loadingTracker` 平行）。

### 改造 `src/server.js` 接线

仿 `loadingTrackerHolder` 模式新增 `reactionTrackerHolder`：

- telegram bot 启动时一并创建 reactionTracker，注入到 `createTelegramBot({ ..., reactionTracker })` 里供 dispatch 使用
- 同一份 reactionTracker 通过 `unwrapHolder` 注入 `createOpenclawHook` 供 Stop / session-end 清理
- wizard 不直接调 reactionTracker（当前没有 wizard 触发的 reaction 加/清需求）
- bot 关停时 `reactionTrackerHolder.current = null`

## 数据流

```
用户在 Telegram topic 发消息
  ↓
telegram-bot.dispatch
  ↓
wizard.handleInbound → result.sessionId
  ↓
reactionTracker.noteUserMessage  ── async ──→  setMessageReaction(✍)
  ↓
PTY 处理一轮（Claude 流式输出）
  ↓
Stop hook 触发 → openclaw-hook.handle('stop')
  ↓
reactionTracker.clearReactionsForSession  ── async ──→  setMessageReaction([]) × N
  ↓
（用户在 idle 状态再发消息：循环回到顶上，新消息也会被加 ✍）
  ↓
PTY 退出 → openclaw-hook.handle('session-end')
  ↓
reactionTracker.clearReactionsForSession（兜底；理论上 stop 已清完）
loadingTracker.stop({ finalStatus: 'done' })  → topic 标题加 ✅ 前缀
```

## 边界与失败模式

1. **bot 在群里没 React 权限**：setMessageReaction 报 403/400 → log warn，
   该 sessionId 这轮的 noteUserMessage 全部失败，不阻塞 wizard / PTY。
2. **群限制了 Available Reactions，✍ 不在允许列表**：setMessageReaction 报错 →
   log warn，建议用户改 `telegram.reactionRunningEmoji` 配置。
3. **同一条消息被多次 noteUserMessage**（理论上不会，但兜底）：list 会重复 push；
   清理时多发一次 setMessageReaction([])，幂等无副作用。
4. **clearReactionsForSession 在 Stop hook 触发时，下一轮新消息已经进来**（race）：
   新消息走 noteUserMessage append 进新 list（旧 list 已被 clearReactionsForSession 取走置空）。
   不会丢；最坏情况是新消息的 reaction 在被 clear 之后才发出，导致 idle 状态下消息上挂着 ✍ ——
   能接受（下一轮 Stop hook 会清掉）。
5. **PTY 异常崩溃**：session-end 兜底清；如果连 session-end 都没到（进程被 kill -9），
   reaction 残留在用户消息上 —— 接受，下次 quadtodo 重启不主动扫历史消息清理。
6. **429 限流**：不主动重试。reaction 是 cosmetic，掉了用户在 next-turn 还会看到新的。
7. **token 缺失**：tracker 内部不感知 token，依赖 telegramBot 抛错；warn 后丢弃。

## 验收标准

### 功能

- [ ] 在 supergroup 的 General 发"帮我做 X"触发任务后，那条用户消息上立刻被加 ✍ reaction。
- [ ] 在 #t42 topic 里回 `c` 触发新一轮 → 这条消息也被加 ✍ reaction。
- [ ] 用户在 idle 状态下连发 3 条消息 → 3 条都被加 ✍ reaction。
- [ ] Stop hook 触发后，这一轮所有用户触发消息上的 ✍ 全部消失。
- [ ] 同时跑 2 个任务，分别在 2 个 topic 里互动，reaction 加/删互不干扰。
- [ ] PTY 自然结束（exit 0）→ topic 标题加 ✅ 前缀；若有残留 reaction 也被清掉。
- [ ] PTY exit ≠ 0 → topic 标题加 ❌ 前缀；reaction 清掉。
- [ ] 用户主动 stop → topic 标题加 ⏹ 前缀；reaction 清掉。

### 非功能

- [ ] topic 标题在 running/idle 阶段不再被 rename（看 telegram log 验证）。
- [ ] setMessageReaction 失败不阻塞 wizard 主流程（断网模拟）。
- [ ] `telegram.reactionEnabled = false` 时全链路退化为旧行为（连 noteUserMessage 都不调）。
- [ ] 配置 `telegram.reactionRunningEmoji = '👀'` 后立即生效（无需重启 bot）。

### 测试

- [ ] **新增 `test/telegram-reaction-tracker.test.js`**：
  - noteUserMessage 异步调 setMessageReaction（用 fake telegramBot 监控调用）
  - clearReactionsForSession 调 setMessageReaction([]) N 次
  - setMessageReaction 抛错时 tracker 不抛
  - 多 sessionId 隔离
  - has / size 正确
- [ ] **`test/telegram-loading-status.test.js`** 现有用例改造：
  - markIdle / markRunning 改为 no-op 后，断言 editForumTopic **不再**被调用
  - start 不再发首次 🔄
  - stop({finalStatus}) 仍发终态前缀
- [ ] **`test/openclaw-hook.test.js`**：
  - telegram route + stop 事件 → reactionTracker.clearReactionsForSession 被调
  - lark route + stop 事件 → larkBot.clearReactionsForSession 被调（保持现有断言）
  - reactionTracker = null 时不抛
- [ ] **`test/openclaw-wizard.test.js`** 现有 markRunning 调用点：
  - markRunning 是 no-op 后，相关 wizard 测试仍能跑过（不依赖 markRunning 的副作用）

## 不在此次范围

- bot 给自己的消息加 reaction（譬如 welcome 消息）—— 不必要，价值低
- 自动探测 Available Reactions 列表 + 自动选 emoji —— 不必要，配置项足够
- 历史 reaction 清理（quadtodo 重启时扫已残留 reaction） —— 不必要
- reaction 速率限制（per-chat 节流）—— 不必要，setMessageReaction 比 editForumTopic 宽松
- 终态用 reaction 表达（替代标题前缀）—— 见方案 C，未采纳
