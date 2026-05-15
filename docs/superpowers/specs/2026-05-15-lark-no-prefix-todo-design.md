# 飞书无前缀建任务（lark-no-prefix-todo）

## 背景

当前 AgentQuad 通过 `src/openclaw-wizard.js` 的 `NEW_TASK_TRIGGERS` 三条正则识别"新建任务"意图：

```js
const NEW_TASK_TRIGGERS = [
  /^(在\s*(?:agentquad|quadtodo)\s*[里中])?\s*(新建|开个|开一?个|创建)\s*[任务todo]/i,
  /^(帮我|帮忙)?\s*(做|搞|修|搞定|实现|写一?个|做一?个|修复|重构|调试|debug|加|开发)/i,
  /^新?任务[:：]/,
]
```

在飞书侧使用时，每次新建任务都要在消息前加 `帮我做` / `新建任务:` 之类前缀，体验不顺手。本设计在飞书路径下增加"非前缀消息自动建任务"能力，保持 Telegram / 微信 / OpenClaw 行为不变。

## 目标

- 在飞书侧发送任意普通文本（不含触发前缀）即可起新建任务向导
- 续聊路径（已绑定 thread / lastPush 命中）不受影响
- 误触可通过现有"取消"语中止
- 行为受 `config.lark.autoCreateTodo` 开关控制，可关闭回到旧行为

## 非目标

- 不修改 wizard 内部的多步流程（workdir → 象限 → 模板）
- 不引入二次确认对话
- 不改 Telegram / 微信 / OpenClaw 路径
- 不引入飞书 bot 主页菜单 / 卡片 shortcut（成本不划算，单独提案）

## 路由设计

`handleInbound` 现有路由优先级（保持不变）：

1. ask_user force_reply
2. CANCEL_TRIGGERS（取消语）
3. DETACH_TRIGGERS（退出 PTY）
4. AgentQuad slash 命令（`/list` `/pending` `/stop` 等，supergroup only）
5. 进行中 wizard 推进
6. NEW_TASK_TRIGGERS 命中 → 起 wizard（旧 `帮我做 X` 路径）
7. ask_user submitReply
8. PTY stdin proxy（thread route → lastPush → 单活跃 session → ambiguous）
9. fallback 友好提示

**新增逻辑：在 step 8 解析 `targetSid === null` 之后、step 9 fallback 之前，插入飞书无前缀建任务分支。**

### 触发条件

全部成立才触发：

- `channel === 'lark'`
- `getConfig()?.lark?.autoCreateTodo !== false`（默认开启）
- `newTaskGateOpen === true`（已有变量；意为不在 supergroup task topic、不在 larkBoundThreadSid 路径）
- step 8 解析得到的 `targetSid` 为 `null`（即没绑定 thread、lastPush 未命中、没有单活跃 session、也不是 ambiguous）
- `trimmed` 非空且不以 `/` 开头（避免把 slash 命令当任务标题）

### 不会触发的场景（自动跳过）

- 飞书消息已绑定到某个 PTY thread（`larkBoundThreadSid` 命中）→ step 0 的 stdin proxy 已消费
- `lastPushByPeer` 命中某 session → step 8 的 (b) 分支消费
- 系统里恰好只有 1 个活跃 PTY session 且 lastPush 未命中 → step 8 的 (c) 分支消费
- 多个活跃 session → step 8 的 (d) 分支返回 `{ambiguous}`，新逻辑判定 `targetSid` 非 null 跳过
- 旧 `帮我做` / `新建任务:` 前缀 → step 6 优先命中
- `autoCreateTodo === false` → 落 fallback

### 起 wizard 的方式

复用现有 `startWizard({ channel, chatId, threadId, text: trimmed, messageId, rootMessageId, imagePaths, userId: fromUserId })`，把整条消息原文当 title 输入。后续 wizard 流程（workdir → 象限 → 模板）完全不变。

`startWizard` 内部的 `extractTitle(text)` 已经能处理任意文本 —— 没有 trigger 前缀时直接返回 trim 后的原文，行为正确。

### 配置开关

`config.lark` 下新增字段：

```jsonc
{
  "lark": {
    // ...existing fields...
    "autoCreateTodo": true  // 默认 true；false 时回到必须加 "帮我做" 前缀的旧行为
  }
}
```

读取方式跟现有 `lark.defaultPermissionMode` 一致。

### 日志

进入新分支时打 info：

```
[wizard] lark auto-create from non-prefix text: chatId=<id> title="<前 80 字符>"
```

便于排查误触和验证开关。

## 验收标准

### 必须通过的单测

| # | 场景 | 期望 |
|---|------|------|
| 1 | lark P2P，发 "修一下登录 bug"，无 lastPush、无 thread 绑定 | 起 wizard，title="修一下登录 bug"，action="wizard_started" |
| 2 | lark 群里新话题首条 "重构 X"，无绑定 | 起 wizard |
| 3 | lark P2P，发 "帮我做 X"（旧路径） | 走 step 6，正常起 wizard（验证不被新逻辑抢） |
| 4 | lark P2P，lastPush 命中某 session，发 "继续看一下" | 走 step 8 PTY proxy，不起 wizard |
| 5 | lark 群里 thread 已绑 session，发 "改一下" | 走 larkBoundThreadSid 路径，不起 wizard |
| 6 | lark P2P，发 "/help" | 落 fallback，不起 wizard |
| 7 | lark P2P，`autoCreateTodo: false`，发 "修 X" | 落 fallback，不起 wizard |
| 8 | telegram P2P，发 "修 X" | 落 fallback（验证 channel 隔离，不影响 tg/微信） |
| 9 | lark P2P 起 wizard 后回 "取消" | wizard 被中止（验证误触可恢复） |

测试位置：新建 `test/lark-auto-create.test.js` 或追加到现有 `test/openclaw-wizard*.test.js`。

### 人工验收

- 在飞书私聊跟 bot 发 "做个签到打卡功能" → bot 按现有 wizard 流程问"选目录"
- 跟 bot 已经聊过任务、且服务没重启 → 发短消息（如 "嗯"）仍能续聊到 PTY，不会变成新任务
- 设置 `autoCreateTodo: false` 重启服务，再发 "做 X" → bot 回 fallback 提示

## 风险与权衡

| 风险 | 缓解 |
|------|------|
| lastPush 缓存过期后，用户想续聊的消息被误建为新任务 | 用户可回"取消"中止（用户已确认能接受，Q3 选项 a） |
| `/foo` 类未知 slash 命令被当任务标题 | 触发条件加 `!trimmed.startsWith('/')` 跳过 |
| 用户粘贴超长文本（如 stack trace）当 title | `extractTitle` 不截断，由用户在 wizard 内自行处理（保持现状） |
| 飞书 bot 在多人群里被误用 —— 任何成员发非命令文本就建任务 | 现有 `getConfig()?.lark?.chatId` 限制只处理白名单 chat；并且只有 `newTaskGateOpen` 才触发，已绑定 thread 的消息不受影响 |

## 不需要改的东西

- Telegram / OpenClaw / 微信路径
- 已绑定 thread 的飞书消息路径
- ask_user / cancel / detach / slash / 进行中 wizard 等所有现有路由
- wizard 内部（workdir / quadrant / template 步骤）
- `NEW_TASK_TRIGGERS` 正则本身（仍保留供 Telegram/微信使用，也是飞书的"显式前缀"快速路径）

## 实现摘要

1. `src/openclaw-wizard.js::handleInbound`：在 step 8 解析 `targetSid` 后、step 9 fallback 前加飞书无前缀分支
2. `src/config.js` 或相应 default config：默认 `lark.autoCreateTodo: true`
3. 新增 / 追加测试用例覆盖表中 9 项场景

预估代码量：wizard 约 25 行，config 约 2 行，测试约 120 行。
