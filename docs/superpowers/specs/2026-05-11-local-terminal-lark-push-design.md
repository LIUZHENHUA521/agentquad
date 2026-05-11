# Local Terminal Resume —— 飞书路由修复

## Problem

`/api/system/open-native-ai-resume`（前端"本地继续"按钮的后端入口）只识别 telegram route。
当 AI session 只绑了飞书路由 (`aiSession.larkRoute`) 时：

1. `buildNativeResumeHookEnv` (`src/server.js:153`) 走到 `if (!isCompleteTelegramRoute(route)) return { env: {}, warnings }` 直接返回 `env: {}`。
2. `buildShellExports(hook.env)` 返回空字符串。
3. 启动到本地 Terminal 的命令前面没有任何 `QUADTODO_*` env。
4. 本地 Claude 跑 Stop hook 时，`~/.quadtodo/claude-hooks/notify.js:39` 看到 `QUADTODO_SESSION_ID` 为空 → `exit 0`。
5. quadtodo server 永远收不到 hook → 飞书 thread 拿不到推送。

次级问题：`/api/system/open-native-ai-resume` (`src/server.js:934`) 只为 telegram route 主动调
`openclawBridge.registerSessionRoute`；Lark 路由依赖 hook handler 的 `restorePersistedRoute` 兜底
反查，能工作但不一致，且首次 hook 到达前若 server 重启过会丢一次。

前端 (`web/src/TodoManage.tsx:1678`) 看到 `telegram_route_missing` 警告会显示"没有 Telegram topic 路由"
——对纯飞书用户文案完全错误，让人以为已经绑过的飞书 thread 也失效了。

## Goals

- "本地继续"对飞书已绑过 thread 的 session 工作：本地 Terminal 起的 `claude --resume` 跑完一轮后，
  飞书原 thread 收到 Stop 推送，session 结束时收到 SessionEnd 推送。
- 不破坏已有 telegram 路径。
- 同时有 lark + telegram 路由的 session 行为可预测（沿用已有"lark 覆盖 telegram"惯例）。
- 没绑过任何 IM 的 session 仍会拿到清晰的警告，前端不再用 telegram-only 文案误导。

## Non-goals

- 不改 hook 脚本 `notify.js` 的协议或字段——避免用户已部署的旧版脚本需要重装。
- 不引入 `QUADTODO_CHANNEL` env（信息已经隐含在 `larkRoute`/`telegramRoute` 字段里）。
- 不改 Codex 本地恢复路径（Codex 走 sidecar fs.watch，与本 bug 无关）。
- 不动 `openclawBridge` 的 sessionRoutes Map 单 route 模型。

## Recommended approach（方案 A）

### server 端：`buildNativeResumeHookEnv` 支持双 channel

`src/server.js:149-176` 现在的形状：

```js
function isCompleteTelegramRoute(route) {
  return Boolean(route?.targetUserId && route?.threadId);
}

function buildNativeResumeHookEnv({ tool, todo, aiSession, runtimeConfig, inspectHooks }) {
  if (tool !== "claude" || !todo || !aiSession) return { env: {}, warnings: [] };
  const warnings = [];
  const route = aiSession.telegramRoute || null;
  if (!isCompleteTelegramRoute(route)) warnings.push("telegram_route_missing");
  ...
  if (!isCompleteTelegramRoute(route)) return { env: {}, warnings };
  ...
}
```

改成（伪代码）：

```js
function isCompleteLarkRoute(route) {
  // 与 src/openclaw-hook.js:normalizePersistedLarkRoute 对齐
  return Boolean(
    route?.targetUserId &&
    route?.rootMessageId &&
    (!route?.channel || route.channel === 'lark')
  );
}

function pickNativeResumeRoute(aiSession) {
  // 优先 lark：与 openclaw-hook.js:restorePersistedRoute / server.js:1497 rehydration 一致
  if (isCompleteLarkRoute(aiSession?.larkRoute)) {
    return { channel: 'lark', route: aiSession.larkRoute };
  }
  if (isCompleteTelegramRoute(aiSession?.telegramRoute)) {
    return { channel: 'telegram', route: aiSession.telegramRoute };
  }
  return { channel: null, route: null };
}

function buildNativeResumeHookEnv({ tool, todo, aiSession, runtimeConfig, inspectHooks }) {
  if (tool !== "claude" || !todo || !aiSession) return { env: {}, warnings: [] };
  const warnings = [];
  const picked = pickNativeResumeRoute(aiSession);

  // hook 安装状态独立检查（与 route 是否存在无关）
  let hookStatus = null;
  try { hookStatus = inspectHooks(); } catch { hookStatus = null; }
  if (!hookStatus?.scriptExists) warnings.push("hook_script_missing");
  if (!hookStatus?.installed) warnings.push("hooks_not_installed");

  if (!picked.route) {
    warnings.push("route_missing");          // 通用：lark/telegram 都没绑
    return { env: {}, warnings };
  }

  const port = runtimeConfig?.port || 5677;
  const env = {
    QUADTODO_SESSION_ID: aiSession.sessionId,
    QUADTODO_TODO_ID: todo.id,
    QUADTODO_TODO_TITLE: todo.title || aiSession.prompt || "",
    QUADTODO_URL: `http://127.0.0.1:${port}`,
  };
  if (picked.channel === 'telegram') {
    env.QUADTODO_TARGET_USER = String(picked.route.targetUserId);
  }
  // Lark 路径不需要 QUADTODO_TARGET_USER：server 端 openclaw-hook 通过 sessionId
  // 反查 lark route（rootMessageId / targetUserId 都在 DB.aiSession.larkRoute 里）。

  return { env, warnings, channel: picked.channel, route: picked.route };
}
```

要点：

- **warning 重命名**：放弃 `telegram_route_missing`，改成通用 `route_missing`。grep 确认只有前端
  `TodoManage.tsx` 这一个消费者。不做 backward compat（私有 API）。
- **hook 安装检查独立于 route 判断**：原代码漏了一种状态——route 缺失时根本不检查 hook 安装。
  虽然该状态下也用不到 hook，但 warnings 顺序应稳定，方便前端按优先级展示。
- **`channel` / `route` 返回字段**：路由处理函数可以根据 `channel` 决定要不要 register。

### server 端：`/api/system/open-native-ai-resume` 处理飞书 route 注册

`src/server.js:933-936`：

```js
const hook = buildNativeResumeHookEnv({ tool, todo, aiSession, runtimeConfig, inspectHooks });
if (isCompleteTelegramRoute(aiSession?.telegramRoute)) {
  openclawBridge.registerSessionRoute(aiSession.sessionId, aiSession.telegramRoute);
}
```

改成（沿用 server.js:1497-1510 rehydration 顺序：telegram 先注册，lark 后注册，lark 胜出）：

```js
const hook = buildNativeResumeHookEnv({ tool, todo, aiSession, runtimeConfig, inspectHooks });
if (isCompleteTelegramRoute(aiSession?.telegramRoute)) {
  openclawBridge.registerSessionRoute(aiSession.sessionId, aiSession.telegramRoute);
}
if (isCompleteLarkRoute(aiSession?.larkRoute)) {
  openclawBridge.registerSessionRoute(aiSession.sessionId, aiSession.larkRoute);
}
```

`isCompleteLarkRoute` 提到 module top-level，与 `isCompleteTelegramRoute` 并列导出（便于单测）。

### 前端：替换 telegram-only 文案

`web/src/TodoManage.tsx:1677-1684`：

```ts
const warnings = result.warnings || []
if (warnings.includes('telegram_route_missing')) {
  message.warning('已在本地 Terminal 中继续；当前会话没有 Telegram topic 路由，不会推送到 Telegram')
} else if (warnings.includes('hooks_not_installed') || warnings.includes('hook_script_missing')) {
  message.warning('已在本地 Terminal 中继续；Claude Code hooks 未安装或脚本缺失，Telegram 推送可能不可用')
} else {
  message.success('已在本地 Terminal 中继续当前会话，Telegram 将接收后续回复')
}
```

改成：

```ts
const warnings = result.warnings || []
if (warnings.includes('route_missing')) {
  message.warning('已在本地 Terminal 中继续；当前会话未绑定 IM 路由（飞书/Telegram），不会同步消息')
} else if (warnings.includes('hooks_not_installed') || warnings.includes('hook_script_missing')) {
  message.warning('已在本地 Terminal 中继续；Claude Code hooks 未安装或脚本缺失，IM 推送可能不可用')
} else {
  message.success('已在本地 Terminal 中继续当前会话，IM 将接收后续回复')
}
```

## 拍板项的默认值

| # | 问题 | 默认 |
|---|------|------|
| 1 | session 同时有 lark + telegram route | 两条都 register；register 顺序与 server.js:1497-1510 一致（lark 后写胜出）。env 也按 lark 注入（`QUADTODO_TARGET_USER` 省略，server 端反查就够）。 |
| 2 | 没绑任何 IM 的 session 是否仍要 warning | 仍发 `route_missing`。前端用通用文案；不在前端做"config 启用了哪个渠道"的额外判断（属于未来优化，超出本 bug）。 |
| 3 | warning 字段是否保留旧名 | 直接重命名为 `route_missing`，不双发；理由：grep 确认无外部消费者。 |
| 4 | 三种缺失状态的文案 | 见上面前端代码片段。 |

## 数据流

```
本地 Terminal:  bash → claude --resume <nativeSessionId>
                          ↓ Claude Code Stop / SessionEnd hook
                  ~/.quadtodo/claude-hooks/notify.js
                          ↓ HTTP POST { sessionId, event, ... }
              quadtodo server /api/openclaw/hook
                          ↓ openclaw-hook.handleClaude
                          ↓ restorePersistedRoute  (兜底，万一 in-memory 没注)
                          ↓ openclawBridge.postText / lark.replyInThread
                              飞书 thread / Telegram topic
```

修复后唯一变化的是"`notify.js` 能跑起来"：因为本地 Terminal 现在拿到了 `QUADTODO_SESSION_ID` 等 env。
后续推送链路全部走现有代码，无新依赖。

## Error handling

- `route_missing`: 不阻塞 native Terminal 启动；前端 warning。
- `hook_script_missing` / `hooks_not_installed`: 同上，warning。
- AppleScript / cwd 不存在等已有 4xx：行为不变。

## Testing

### 单元测试（新）

新增 `test/server.native-resume-hook-env.test.js`（或挂到现有的 server 测试套件），覆盖
`buildNativeResumeHookEnv` 的四种 aiSession 输入：

1. **lark-only**: `aiSession.larkRoute` 完整、无 telegramRoute
   - env 含 `QUADTODO_SESSION_ID / TODO_ID / TODO_TITLE / URL`
   - env **不**含 `QUADTODO_TARGET_USER`
   - warnings 不含 `route_missing`、`telegram_route_missing`
   - 返回的 `channel === 'lark'`
2. **telegram-only**: 现有行为不变
   - env 含 `QUADTODO_TARGET_USER`
   - warnings 不含 `route_missing`
   - `channel === 'telegram'`
3. **both**: lark 完整 + telegram 完整
   - 走 lark 分支（与 rehydration 一致）
   - env **不**含 `QUADTODO_TARGET_USER`
   - `channel === 'lark'`
4. **neither**: 都缺
   - env 为空
   - warnings 含 `route_missing`，不含 `telegram_route_missing`

附加：

- hook script missing / not installed 两种 warning 仍在路由缺失时一并 push（顺序不变）。

### 集成测试（新或扩展）

`test/openclaw-hook.lark-followup.integration.test.js` 已有的 Lark 推送验证 + 增加一项：
模拟 `/api/system/open-native-ai-resume` 返回的 env 注入到 Claude hook 调用 → 走完 lark 推送。
若改动太大，本测试可只增加 server 路由层：post 一个 lark-only session 到 /open-native-ai-resume，
assert response 含正确的 command 串（包含 `export QUADTODO_SESSION_ID=...`）且 `openclawBridge` 内
该 sessionId 的 route 已注册。

### 回归

- `test/ai-terminal.route.test.js` 全绿。
- `test/openclaw-hook.test.js`, `test/openclaw-hook.lark-followup.integration.test.js` 全绿。
- 手工验收：见下。

## 手动验收

1. Lark thread 已绑过 root_message 的 session：
   1. 点"本地继续"。
   2. macOS Terminal 新开 / 复用 tab，命令前缀含 `printf '[quadtodo] session marker: ...'; cd ...; export QUADTODO_SESSION_ID=...; export QUADTODO_TODO_ID=...; export QUADTODO_TODO_TITLE=...; export QUADTODO_URL=http://127.0.0.1:5677; <bin> --resume <id>`。
   3. 检查命令里**不**含 `QUADTODO_TARGET_USER`（lark 不需要）。
   4. 前端 toast 显示 "已在本地 Terminal 中继续当前会话，IM 将接收后续回复"。
   5. 在本地 Claude 里发一句，Claude 回复结束后，**原飞书 thread 收到推送**。
   6. 退出 Claude（`/exit`）→ 飞书 thread 收到 SessionEnd 推送（带 transcript）。
2. Telegram topic 已绑过的 session：
   1. 点"本地继续"，命令前缀含 `QUADTODO_TARGET_USER`。
   2. Claude 回复结束后 Telegram topic 收到推送（回归）。
3. Lark + Telegram 都绑过：
   1. 命令前缀**不**含 `QUADTODO_TARGET_USER`（lark 胜出）。
   2. Claude 回复结束后**飞书 thread**收到推送（与 in-memory route 的 lark 覆盖一致）。
4. 都没绑的 session：
   1. 前端 toast 显示 "已在本地 Terminal 中继续；当前会话未绑定 IM 路由…"。
   2. 本地 Terminal 仍能跑（不阻塞）。

## Out-of-scope follow-up（不在本次实现内）

- 让 `route_missing` 在 config 完全没启用 lark/telegram 时静默：依赖 `runtimeConfig` 的 enable flag，需要单独评估。
- bridge 改成 sessionRoutes 支持每 sid 多条 route（lark + telegram 同时推送两边）：架构性变更，留给以后。
