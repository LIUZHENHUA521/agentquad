# 删除「默认工具」与 dispatch.web 死配置 — 设计文档

- **日期**: 2026-05-14
- **范围**: web 设置抽屉 + 后端 config / dispatch 模块
- **背景**: 主人在设置抽屉里看到"默认工具"和"按渠道分发工具 → web"两栏，怀疑没用；调研确认 web 端 100% 不读这两项配置，需要清理掉。

---

## 一、当前真实生效路径（调研结论）

`resolveTool` 函数全项目仅 2 处调用：
- `src/openclaw-wizard.js:670` — channel 取 `w.channel`（实际值是 `lark` / `telegram`）
- `src/mcp/tools/openclaw/index.js:197` — channel 默认 `'openclaw'`

Web 端启动 AI 会话的路径（TodoCard → `handleAiExec` → `startAiExec` → `/api/ai-terminal/exec` → `spawnSession`）全程显式传 `tool` 参数，**不调用 `resolveTool`、不读 `defaultTool`、不读 `dispatch`**。

所以：
- `dispatch.web.*` 整段是死配置（永远没人以 `channel: 'web'` 调用 `resolveTool`）
- `defaultTool` 仅在 OpenClaw MCP 路径下、且 `dispatch.openclaw` 不存在时作为兜底——而 `dispatch.openclaw` 本来就不存在，所以这是唯一生效场景。主人决定不为这个孤立场景保留全局字段，让它硬编码兜底到 `'claude'` 即可。

---

## 二、目标

1. 设置抽屉里彻底移除"默认工具"和"按渠道分发工具 → web"两个 UI 元素
2. 后端 `config.json` 不再写出 `defaultTool` 字段；`dispatch` 节点不再包含 `web` 子项
3. 旧 config.json 里已有的这两个字段，加载时静默丢弃，不向用户报错、不向上传播
4. `resolveTool` 函数继续存在（lark/telegram/openclaw 还在用），但 fallback 链中去掉 `config.defaultTool` 一级，最终回退到硬编码 `'claude'`
5. 测试同步更新，全绿

---

## 三、改动清单

### 后端 (`src/`)

**`src/dispatch.js`** — `resolveTool`
```js
// before
if (SUPPORTED_TOOLS.includes(config?.defaultTool)) return config.defaultTool
return 'claude'

// after
return 'claude'
```
函数签名不变；`config` 参数保留（dispatch 还从里头取）。

**`src/config.js`**
- `defaultConfig()` 内删 `defaultTool: "claude"` 字段
- `normalizeDispatch()` 的 channels 数组从 `['lark', 'telegram', 'web']` 改成 `['lark', 'telegram']`
- `normalizeConfig()` 加一个清洗步骤：若入参里有 `cfg.defaultTool` / `cfg.dispatch?.web`，丢弃即可（不复制到 `out`）
- `loadConfig` / 持久化路径不需要单独迁移——`normalizeConfig` 起手就会过滤旧字段，新写出的 config.json 自然没有这两项

**`src/cli.js`**
- 删除 `r.defaultTool` 相关分支（first-run wizard 不再询问默认工具）
- 检查 `setConfigValue` 调用点是否还有传 `'defaultTool'` 的，删之
- runtime config 拼装里凡是 `cfg.defaultTool` 的引用全部清掉

**`src/server.js`**
- 同样清理对 `config.defaultTool` 的引用（如有），以及 `updateConfig` 返回里 `runtimeApplied.defaultTool` 字段

**`src/first-run-wizard.js`** / **`src/openclaw-wizard.js`**
- 不再询问/写入 `defaultTool`
- `openclaw-wizard.js` 里 `resolveTool` 调用不变（仍然传 cfg），让函数自己 fallback 到 `'claude'`

### 前端 (`web/src/`)

**`web/src/api.ts`**
- `AppConfig` 接口删 `defaultTool: AiTool` 字段
- `updateConfig` 返回类型里删 `runtimeApplied.defaultTool`
- `dispatch` 节点类型从 `{ lark?; telegram?; web?; }` 改成 `{ lark?; telegram?; }`

**`web/src/SettingsDrawer.tsx`**
- 删 Form 字段 `defaultTool`（第 747–757 行整个 Form.Item）
- `dispatchDraft` state 类型移除 `web` 子项
- 初始化 / 提交时不再读写 `defaultTool` 和 `dispatchDraft.web`
- `dispatchSection` 里的 Collapse channels 从 `['lark', 'telegram', 'web']` 改成 `['lark', 'telegram']`
- 移除 `webHint` 文案分支

**i18n** (`web/src/i18n/locales/{zh-CN,en-US}.ts`)
- 删 key：`settings.tools.defaultToolLabel` / `defaultToolExtra` / `defaultToolRequired`
- 删 key：`settings.dispatch.webHint`
- 更新 `settings.dispatch.extra` 文案：去掉"Web"、去掉"全局 defaultTool"

### 测试

**`test/dispatch.test.js`**
- 测试 fixture 里删 `dispatch.web` 和 `defaultTool` 字段
- 删用例「falls back to "claude" when defaultTool missing」中关于 `channel: 'web'` 的断言，或改为 `channel: 'openclaw'`
- 删用例「back-compat: missing dispatch section → defaultTool」（因为 defaultTool 不存在了，这条断言不再有意义；改成"missing dispatch section → 'claude'"）

**`test/config.test.js`** / **`test/first-run-wizard.test.js`** / **`test/openclaw-wizard.test.js`** / **`test/openclaw-wizard.dispatch.test.js`** / **`test/server.test.js`** / **`test/cli-default-action.test.js`**
- 遍历这些文件里所有对 `defaultTool` 的引用：
  - 测试 fixture 里的 `defaultTool: 'xxx'` 直接删
  - 任何"断言 config 里包含 defaultTool"的检查改成"断言 config 里**不**包含 defaultTool"
  - 任何依赖 `defaultTool` 实际生效的行为测试改成断言 `resolveTool` 兜底到 `'claude'`

### 数据迁移

无显式迁移脚本。`normalizeConfig` 起手就过滤旧字段，新 config.json 写出时自然干净。旧的 `config.json` 在内存里被忽略后，下一次写盘自动消失。无版本号检查、无用户提示。

---

## 四、验收标准

- [ ] `npm test` 全绿
- [ ] `node src/cli.js start` 启动后，浏览器打开设置 → 工具
  - 不再有"默认工具" radio
  - "按渠道分发工具" Collapse 只剩 `lark` / `telegram`
- [ ] 用一份**包含旧字段**的 config.json 启动（`defaultTool: "codex"`、`dispatch.web.default: "codex"`），不报错；保存任意设置后再读 config.json，旧字段已被清除
- [ ] TodoCard 上「Start Claude/Codex/Cursor」三个入口行为不变（依然按用户点的工具启动）
- [ ] grep 全仓库 `defaultTool`，应该只剩注释 / 已删除文案残留为零；`dispatch.*web` 同理
- [ ] OpenClaw MCP `start_ai_session`（如果还测得到）以 `channel='openclaw'` 调用时，`resolveTool` 返回 `'claude'`

---

## 五、暂不做

- 不删 `resolveTool` 函数本体（lark/telegram dispatch 还在用）
- 不改 OpenClaw MCP 或 wizard 的调用方式
- 不动 `dispatch.lark` / `dispatch.telegram` 的 UI 与逻辑

---

## 六、风险

1. **遗漏的字段引用**：`defaultTool` 散落在前后端多处，需要 grep 兜底（grep 关键字：`defaultTool`、`'web'` 在 dispatch 上下文）
2. **测试夹具陈旧**：6 个测试文件提到 `defaultTool`，要逐一确认改后行为还合理
3. **前端类型推断**：删了 `AppConfig.defaultTool` 后 TS 编译可能报多处错，需要全部清理
