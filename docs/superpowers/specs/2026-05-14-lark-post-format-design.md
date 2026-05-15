# 飞书消息格式优化 — 改用 post 富文本

## 背景

飞书 bot 当前发的所有消息都走 `msg_type: 'text'`，`src/lark-api-client.js:47` 是唯一发送入口。
所有 markdown 输入经过 `src/lark-markdown.js` 的 `toLarkText()` 降级成纯文本。

降级策略的两个妥协（注释里写得很坦白）：

- 表格 `| a | b |` 保留原样（飞书 text 不渲染，"但能读"）
- 标题 `#..######` 只去掉前缀（失去层级）

直接后果：plan 完成通知这类含 markdown 表格 + 多级标题的长消息，
在飞书里看就是裸露的 `|---|---|---|` 分隔行 + 没有层级的标题，
和正文文字混在一起，几乎不可读。截图见用户上传。

## 目标

把"含 markdown 的长消息"在飞书里渲染成有视觉层级的富文本，
同时不破坏现有"纯文本短消息"（命令回显、状态行）的发送路径。

## 方案

切到飞书 `msg_type: 'post'` 富文本（rich_text）。

### 1. 入口形态

改造现有 `sendMessage / replyInThread`，内部按 `format` 参数三分支：

- `format: 'auto'`（默认）：检测内容是否含 markdown，含则走 post，否则走 text
- `format: 'post'`：强制 post
- `format: 'text'`：强制 text（兼容老行为）

判据（只看**块级特征**，任一命中即视为 markdown）：

- 行首 `#{1,6}\s` 标题
- 含表格分隔行 `|\s*-+\s*\|`
- 含三反引号代码块围栏
- 含行首列表 `^[-*]\s` 或 `^\d+\.\s`
- 含行首引用 `^>\s`

inline `**bold**` / `*emphasis*` 单独出现不触发升级（避免普通强调短句被误判）。

旧 caller 不传 `format` → 默认 `auto`，自动获益。

### 2. markdown → post AST 转换器

新文件 `src/lark-post.js`，导出 `toLarkPost(markdown) → { zh_cn: { content: [[...]] } }`。

按 markdown 块级元素逐块转换：

| markdown | post 输出 |
|---|---|
| `# H1` | 一行：`━━━ H1 ━━━` text + style bold |
| `## H2` | 一行：`▎H2` text + style bold |
| `### H3+` | 一行：`· H3` text + style bold |
| 段落 | 一行 text（含粗体/链接/代码内联展开） |
| `**bold**` | text + style `["bold"]` |
| `[label](url)` | tag `a` href=url text=label |
| inline `` `code` `` | text + style `["italic"]`（post 无 inline code，用斜体近似） |
| ```` ```lang ... ``` ```` | tag `code_block` language=lang text=内容 |
| `- item` / `* item` | 一行：`• item`（保留缩进） |
| `1. item` | 一行：`1. item` |
| `> quote` | 一行：`▎ quote` |
| `---` 水平线 | tag `hr` |
| markdown 表格 | 表头行 bold 渲染，数据行 `**列1** · 列2 · 列3 · ...`（拆成行） |
| 图片 `![](url)` | 丢弃（和现状一致） |

注意：post `content` 是"段落数组"，每段是"tag 数组"。段间渲染时飞书自动换行。

### 3. 表格处理细节

**识别条件**：连续两行匹配 `^\|.*\|$`，且第二行是分隔行 `|---|---|`。
不满足该条件的 `|` 行视为普通段落，原样输出。

确认是表格后：

- 跳过分隔行 `|---|---|`
- 表头行 → 输出 `**header1** | **header2** | ...`（bold 锚点）
- 数据行 → 输出 `**col1** · col2 · col3 · ...`（col1 加 bold 当行锚点）
- 单元格内容修剪空白，空单元格用 `—` 占位

### 4. 失败回退

post 调用失败（飞书拒收 / 字段超长 / 接口异常）→ 自动 fallback 到原 text 路径，
日志降级为 warn 但不抛错，消息不丢。

实现位置：`lark-api-client.js` 的 sendMessage/replyInThread try/catch 后增加 fallback。

### 5. 不在范围

- `sendCard / replyWithCard`（权限按钮卡片）不动
- `toLarkText` 保留，作为 fallback 兜底
- 不引入新的飞书 markdown 配置入口（应用维度）

## 受影响文件

| 文件 | 改动 |
|---|---|
| `src/lark-post.js` | **新增** — markdown → post AST 转换器 |
| `src/lark-api-client.js` | sendMessage/replyInThread 加 format 分支 + 失败 fallback |
| `src/lark-bot.js` | sendMessage/replyInThread 透传 format（可选参数）|
| `test/lark-post.test.js` | **新增** — AST 单测 |
| `test/lark-api-client.test.js` | 新增 post 路径 + fallback 用例（如已有该文件） |

## 验收标准

1. 用户截图里的 plan 完成通知 markdown 文本，重新发一次飞书：
   - 三层标题 `变更摘要` / `计划骨架` / `仍需你确认` 有明显视觉区分
   - 表格区不再出现 `|---|---|`，每行紧凑可读
   - commit hash 等代码片段有视觉边界
2. 纯文本短消息（不含 markdown 特征）仍走 text 路径，bit-exact 不变
3. `test/lark-post.test.js` 覆盖：标题、表格、代码块、链接、列表、嵌套混合、空字符串、超长输入
4. post 失败时单测验证 fallback 到 text，返回值仍是 `{ok: true, payload}`
5. `npm test` 全绿，所有 `lark-*` 现有测试零回归

## 风险

- **误判**：短消息里恰好出现 `#tag` 或 `*emphasis*` 会被升级到 post。判据要求至少匹配一条"块级"特征（行首 `#`、表格分隔行、围栏代码），把 inline `**bold**` 单独不算（避免普通强调字符串触发）。
- **post 字段上限**：单条 post 内容有 30KB 上限（飞书 API），现状 toLarkText 长消息会被截到 4000 字，post 路径同样要做长度兜底。
- **lark_md 不等于 post**：interactive card 的 `lark_md` tag 和 post 是两套语法，本方案只用 post，不混用。

## 操作命令

实现后手测：

```
# 临时脚本读 spec 截图对应 markdown，调 sendMessage 看效果
node -e "import('./src/lark-post.js').then(m => console.log(JSON.stringify(m.toLarkPost(fs.readFileSync('/path/to/plan.md','utf8')), null, 2)))"
```

实测通过后提交。
