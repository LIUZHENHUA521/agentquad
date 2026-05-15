# 飞书无前缀建任务（lark-no-prefix-todo）

## 背景

当前 AgentQuad 在 `src/openclaw-wizard.js` 用 `NEW_TASK_TRIGGERS`（三条正则，line 19-23）识别"新建任务"意图。飞书侧每次都要写 `帮我做` / `新建任务:` 前缀才能建任务，用户反馈太麻烦。

本设计在飞书路径下增加"非前缀消息自动建任务"分支，旧前缀路径与 Telegram/微信/OpenClaw 路径完全不动。

## 目标

- 飞书发送任意非命令文本（且未匹配续聊路径）→ 自动起新建任务向导，文本原文作为 title
- 续聊路径（已绑定 thread / lastPush 命中 / 单活跃 session）不受影响
- 误触可通过现有 `取消` / `cancel` 中止
- 由 `config.lark.autoCreateTodo` 开关控制，默认开启；关闭后回到旧行为

## 非目标

- 不改 wizard 的多步流程（workdir → 象限 → 模板），用户 Q1 选了 (a)
- 不加二次确认对话，用户 Q3 选了 (a) 能接受误触
- 不改 Telegram / 微信 / OpenClaw 路径
- 不在 Web Settings Drawer 暴露开关（v1 只走 JSON config；按需再加 UI）
- 不修复 `extractTitle` 的 suffix 误剥问题（见"已知限制"）

## 路由设计

`handleInbound` 的现有路由编号沿用代码注释（src/openclaw-wizard.js:1372-1744）：

| Step | 名称 | 行号 |
|------|------|------|
| 0 | Lark bound thread → stdin proxy（larkBoundThreadSid 命中） | 1287-1346 |
| 0.5 | ask_user force_reply | 1351 |
| 1 | CANCEL_TRIGGERS | 1373 |
| 1.5 | DETACH_TRIGGERS | 1380 |
| 1.7 | AgentQuad slash 命令（supergroup） | 1404 |
| 2 | 进行中 wizard 推进 | 1446 |
| 3 | NEW_TASK_TRIGGERS 命中 → 起 wizard（旧 `帮我做` 路径） | 1479 |
| 4 | ask_user submitReply | 1509 |
| 5 | PTY stdin proxy | 1526 |
| 6 | fallback 友好提示 | 1722 |

### 改动点

**Step 5 内部**和**Step 5 → Step 6 之间**都要插入新逻辑。原因：step 5 解析 `targetSid` 时，对未绑定的 lark thread 会早返回 `{notFound: true}` + 回复 "没有找到对应运行中的任务"（line 1568-1573），从不到达 step 6。所以仅在 step 6 前插入不够。

**新逻辑插入两处**（统称 "step 5.5 lark auto-create"）：

1. **改写 step 5 内 `targetSid.notFound` 分支**（line 1568）：
   ```
   if (targetSid && targetSid.notFound) {
     if (shouldLarkAutoCreate(...)) → 起 wizard
     else → 原 "没有找到对应运行中的任务" 回复
   }
   ```

2. **在 step 5 整段结束后、step 6 前**（line 1720 ↔ 1722）：
   ```
   if (shouldLarkAutoCreate(...)) → 起 wizard
   ```
   覆盖 step 5 "返回 null"（无 lastPush、无单活跃 session）以及 step 5 整段被 `isInGeneralOfSupergroup` 短路跳过的情况。

### `shouldLarkAutoCreate(trimmed, channel, newTaskGateOpen, targetSid?)` 触发条件

全部为真才触发：

- `channel === 'lark'`
- `getConfig()?.lark?.autoCreateTodo !== false`
- `newTaskGateOpen === true`（已有变量；意为不在 Telegram supergroup task topic、不在 larkBoundThreadSid 路径）
- `trimmed` 非空
- 不命中 slash 正则：`!/^\/[a-z][a-z0-9_]*\b/i.test(trimmed)`（与 step 1.7 line 1404 同款，避免飞书侧 `/foo` 被当任务标题）

### 不会触发的场景（自动跳过 + 复核）

| 场景 | 为何不触发 |
|------|----------|
| 已绑定 lark thread + alive PTY | step 0 larkBoundThreadSid 早消费 |
| 已绑定 lark thread + ended PTY | step 5 `{ended: true}` 分支早返回 "任务已结束" |
| `帮我做 X` / `新建任务: X` | step 3 NEW_TASK_TRIGGERS 优先 |
| lastPush 命中 | step 5 (b) 写入 PTY |
| 系统只有 1 个活跃 PTY 且 lastPush 未命中 | step 5 (c) 写入 PTY（保持现状） |
| 多活跃 PTY | step 5 (d) 返回 `{ambiguous}`，新逻辑跳过，原 ambiguous 选择器回复 |
| 进行中 wizard | step 2 优先 |
| `取消` / `cancel` / `/list` 等 | 前置 step 拦截 |
| `autoCreateTodo === false` | 直接跳过新逻辑 |
| 空 `trimmed`（含纯图消息） | 不触发，落 step 6 fallback |
| 非 lark channel（telegram/微信/openclaw） | `channel === 'lark'` 守门 |

### 起 wizard 的方式

复用 `startWizard({ channel: 'lark', chatId, threadId, text: trimmed, messageId, rootMessageId, imagePaths, userId: fromUserId })`，返回值按 step 3 的处理逻辑（line 1481-1505）打 reply。所有字段语义与旧路径一致，wizard 内部完全不变。

### 配置开关

**`src/config.js`**：

```js
const DEFAULT_LARK_CONFIG = {
  // ...existing fields...
  autoCreateTodo: true,  // 🆕
};
```

normalizer（line 423-436）的 `{...DEFAULT_LARK_CONFIG, ...(cfg.lark || {})}` 已经会把 boolean 字段透传过来，无需额外处理逻辑。

**读取**：`getConfig()?.lark?.autoCreateTodo !== false` —— 默认 true，仅显式设 false 才关闭。

**Web Settings Drawer**：v1 不暴露。`test/settings-drawer-lark-config.test.js` 不会因新增字段失败（它只断言现有字段存在，不断言只有这些字段）。

### 日志

进入 auto-create 分支时打 info：

```
[wizard] lark auto-create from non-prefix text: chatId=<id> thread=<id|-> title="<前 80 字符>"
```

便于排查误触和验证开关。

## 验收标准

### 必须通过的单测

新建 `test/lark-auto-create.test.js`（或追加到 `test/openclaw-wizard*.test.js`）：

| # | 场景 | 期望 |
|---|------|------|
| 1 | lark P2P，发 "修一下登录 bug"（无 lastPush、无 thread 绑定、无活跃 session） | 起 wizard，title="修一下登录 bug"，action="wizard_started" |
| 2 | lark 群里**未绑 session 的 thread** 首条 "重构 X"（targetSid.notFound 路径） | 起 wizard，不再回 "没有找到对应运行中的任务" |
| 3 | lark P2P，发 "帮我做 X" | step 3 命中，正常起 wizard（验证不被新逻辑抢） |
| 4 | lark P2P，lastPush 命中某 session，发 "继续看一下" | step 5 (b) 写 PTY，不起 wizard |
| 5 | lark 群里 thread 已绑 alive PTY，发 "改一下" | step 0 stdin proxy，不起 wizard |
| 6 | lark P2P，发 `/help` | 落 fallback（slash 守门），不起 wizard |
| 7 | lark P2P，发 `/wat`（未知 slash） | 落 fallback，不起 wizard（验证 slash regex 严格） |
| 8 | lark P2P，`autoCreateTodo: false`，发 "修 X" | 落 fallback，不起 wizard |
| 9 | telegram P2P，发 "修 X" | 落 fallback（channel 隔离） |
| 10 | lark P2P 起 wizard 后回 "取消" | wizard 被中止 |
| 11 | lark P2P + 多活跃 PTY，发 "做 X" | step 5 (d) ambiguous 选择器回复，不起 wizard（保留旧行为） |
| 12 | lark P2P，纯图消息（trimmed 空 + imagePaths 非空） | 不起 wizard，落 step 6 fallback（避免误判图片消息意图） |

### 人工验收

- 在飞书私聊跟 bot 发 "做个签到打卡功能" → bot 按现有 wizard 流程问"选目录"
- 跟 bot 已经聊过任务、且服务没重启 → 发短消息（如 "嗯"）仍能续聊到 PTY，不会变成新任务
- 在群里新建话题、bot 没参与过 → 首条消息直接起 wizard
- 设置 `autoCreateTodo: false` 重启服务，再发 "做 X" → bot 回 fallback 提示

## 风险与权衡

| 风险 | 缓解 |
|------|------|
| lastPush 缓存过期后用户想续聊的消息被误建为新任务 | 用户回 `取消` 中止；Q3 已确认能接受 |
| 用户在飞书 P2P 发 "嗯" / "ok" / "👀" 这种短消息也会建任务 | 系统有 lastPush 缓存（最近推过的 session）兜底；缓存失效后才走 auto-create —— 误触率可控 |
| `/foo` 风格被当任务标题 | slash 正则与 step 1.7 一致守门 |
| 用户粘超长文本当 title | `extractTitle` 不截断；wizard 内部 title 渲染时已用 `slice(0, 96)`（line 845/919）保护下游 |
| 群里被多人误用 | 现有 `getConfig()?.lark?.chatId` 限制只处理白名单 chat |

## 已知限制（不在本 spec 修复）

- **`extractTitle` 的 suffix 剥离误伤**：line 147-150 会无条件剥离 `XX 目录:Y` / `XX 象限 N` / `XX 模板` 后缀。如用户发 "我想做个签到模板"，title 会变成 "我想做个"（"签到模板" 被当成模板 hint 剥掉）。这是 `extractTitle` 既有行为，旧 `帮我做` 路径也有同样问题。本 spec 不修复，新建任务路径里继承该行为，用户在 wizard 第一步前能看到 `任务: 我想做个` 主动取消重发。需修复另开 spec。
- **空文本 + 图片消息不自动建任务**：纯图消息（用户发个截图问 "看下这个 bug"）由于 trimmed 为空，会落 step 6 fallback。如果未来要支持，需要用图片 OCR / caption 或固定 `(图片任务)` title，先不做。

## 不需要改的东西

- Telegram / OpenClaw / 微信路径（`channel === 'lark'` 守门）
- 已绑定 lark thread 的消息路径（step 0 / step 5 ended 早消费）
- ask_user / cancel / detach / slash / 进行中 wizard 等所有现有路由
- wizard 内部（workdir / quadrant / template 步骤）
- `NEW_TASK_TRIGGERS` 正则本身（仍是飞书"显式快速路径"，也是 Telegram/微信主路径）
- Web Settings Drawer / `test/settings-drawer-lark-config.test.js`

## 实现摘要

1. **`src/openclaw-wizard.js`**：
   - 在 `handleInbound` 内提取局部 helper `shouldLarkAutoCreate(trimmed, channel, newTaskGateOpen, autoCreateTodoFlag)`。
   - Step 5 解析 `targetSid` 后：当 `targetSid?.notFound` 且 helper 返回 true → 跳过原 "没有找到运行中的任务"，走 wizard 启动逻辑。
   - Step 5 结束、step 6 之前：当 helper 返回 true → 起 wizard。
   - Wizard 启动后的 reply 构造完全复用 step 3 (line 1481-1505) 的形态。
   - 增 `[wizard] lark auto-create...` info log。
2. **`src/config.js`**：`DEFAULT_LARK_CONFIG` 增 `autoCreateTodo: true`。
3. **`test/lark-auto-create.test.js`**：覆盖表中 12 项场景。

预估代码量：wizard 约 30 行，config 约 1 行，测试约 150 行。
