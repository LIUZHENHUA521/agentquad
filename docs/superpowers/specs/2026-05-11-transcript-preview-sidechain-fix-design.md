# Transcript 预览 — subagent 空白修复设计

**日期**：2026-05-11
**入口**：「历史会话找回」抽屉的「预览」按钮（`web/src/transcripts/TranscriptSearchDrawer.tsx`）
**一句话**：preview 模式不再过滤 `isSidechain`，让 subagent transcript 文件能预览出内容；同时给 modal 加空状态兜底，杜绝白屏。

## 背景与动机

「历史会话找回」抽屉里搜索到的 transcript 记录，点「预览」时弹窗里**完全空白**——只有标题和关闭按钮，连"无内容"提示都没有。

100% 复现路径：搜索任一 claude 会话（如 `35bf6977-0695-4ca4-82af-a234fb357be5`），其 25 条 transcript_files 中有 24 条来自 `subagents/agent-*.jsonl`，点这 24 条任意一条预览都是空白。

### 根因

`src/transcripts/scanner.js` 的 `parseClaudeFile(filePath, { preview: true })` 在 68–72 行：

```js
if (preview) {
  if (j.isMeta || j.isSidechain) continue   // ← 把整个 subagent 文件全丢了
  if (j.type !== 'user' && j.type !== 'assistant') continue
}
```

- subagent jsonl 文件**每一行都是 `isSidechain: true`**（这是 sidechain 的本质——子代理的旁路对话被单独存盘）。
- 索引扫描时走的是 `parseClaudeFile(..., { preview: false })`，不过滤 sidechain，所以 `turn_count` 入库时是正数；用户在搜索列表里看到的就是这些正数。
- 而 preview 模式过滤掉 sidechain → `turns = []`、`totalTurns = 0` → 前端 modal 拿到空数组渲染白屏。

注释里说"和 `buildFullTranscript` 对齐"，但 `buildFullTranscript`（`src/claude-transcript.js:137`）是给**主会话**生成 SessionEnd markdown 附件用的，过滤 sidechain 是为了排除子代理噪音——预览场景目标完全不同，复用这条规则是错误的对齐方向。

### 次要问题

前端 modal（`TranscriptSearchDrawer.tsx:347-404`）在 `previewTurns=[]` 且 `previewTotal=0` 时没有 `<Empty/>` 兜底；catch 块也没把 `previewFile` 清空。无论是 parser 修好后偶发的真空文件，还是 API 失败，都可能再次出现"白壳 modal"。

## 非目标

- 不改索引时的 `parseClaudeFile(..., { preview: false })` 行为（FTS / `turn_count` / `searchTranscripts` 都不动）。
- 不改 `buildFullTranscript`（SessionEnd 附件场景仍应过滤 sidechain）。
- 不引入 reason 枚举区分"全过滤掉"vs"文件不存在"vs"解析失败"——三种情况统一显示同一个 Empty 文案。
- 不改 codex / cursor 的 parser（codex 没有 sidechain 概念，cursor 也没；本 bug 只在 claude 出现）。

## 方案概述

两点改动：

1. **`src/transcripts/scanner.js`**：preview 模式只过滤 `isMeta` 与非 user/assistant 类型，**不再过滤 `isSidechain`**。
2. **`web/src/transcripts/TranscriptSearchDrawer.tsx`**：preview modal 内容区在 `!previewLoading && previewTurns.length === 0` 时显示 `<Empty description="该会话暂无可展示内容" />`；preview API 失败的 catch 块里把 `previewFile` 一起置 `null`，错误后不留空壳。

## 变更点

### 1. `src/transcripts/scanner.js`（修改）

第 68–72 行的 preview 过滤条件改为：

```js
// preview 模式：剔除 meta（local-command-caveat 等噪音）与非 user/assistant 类型。
// 注意：不能过滤 isSidechain —— subagent transcript 文件全部是 sidechain，
// 过滤后会变成空预览（与索引时 turn_count 不一致）。
if (preview) {
  if (j.isMeta) continue
  if (j.type !== 'user' && j.type !== 'assistant') continue
}
```

注释同步更新。`src/transcripts/index.js:160` 里那条 "preview 模式：包含 tool_use / tool_result 摘要，过滤 isMeta/isSidechain；" 注释也对应修正为只提 `isMeta`。

### 2. `web/src/transcripts/TranscriptSearchDrawer.tsx`（修改）

#### 2.1 Empty 兜底

`<Spin spinning={previewLoading}>` 内部、`previewTurns.map(...)` 之前加一个分支：

```tsx
{!previewLoading && previewTurns.length === 0 ? (
  <Empty description="该会话暂无可展示内容" />
) : (
  // 现有 previewTurns.map(...) + 加载更多按钮
)}
```

布局：Empty 居中，外层保留现有的 `maxHeight: 480` 容器（避免空状态下 modal 高度突变）。

#### 2.2 错误时关闭 modal

`handlePreview` 和 `loadMorePreview` 的 catch 块各加一行：

```ts
async function handlePreview(f: TranscriptFile) {
  setPreviewFile(f)
  setPreviewLoading(true)
  setPreviewTurns([])
  setPreviewTotal(0)
  setExpandedTurns(new Set())
  try {
    const r = await previewTranscript(f.id, 0, PREVIEW_PAGE_SIZE)
    setPreviewTurns(r.turns)
    setPreviewTotal(r.totalTurns)
  } catch (e) {
    message.error((e as Error).message)
    setPreviewFile(null)              // ← 新增：错误时关闭 modal
  } finally {
    setPreviewLoading(false)
  }
}
```

`loadMorePreview` 出错时已经有 modal、只是分页失败，**不**关闭 modal——保留现有 message.error 即可。

### 3. `test/transcripts.scan.test.js`（新增用例）

加一个 case 覆盖 sidechain 预览：

- 构造一个临时 jsonl，里面同时包含主线 user 一条 + sidechain user/assistant 各一条。
- 调 `parseTranscriptFile('claude', tmpPath, { preview: true })`：
  - assert 返回的 `turns.length === 3`（sidechain 不再被丢）
  - assert 主线 user 的 content 仍在第一位

确保后续重构不会无意中把 sidechain 过滤改回来。

## 数据流

```
[搜索抽屉] 用户点「预览」
      ↓
GET /api/transcripts/:id/preview
      ↓
service.preview(fileId)
      ↓
parseTranscriptFile('claude', path, { preview: true })
      ↓
parseClaudeFile  ──修改后──>  保留 sidechain 行
      ↓
{ turns: [...], totalTurns: N }
      ↓
[前端] previewTurns = r.turns
       │
       ├── N>0 → 渲染 turn 列表（现状）
       └── N===0 → 渲染 <Empty/>（新增兜底）
```

## 风险与边界

- **主会话预览会多出 sidechain 轮次**：用户在主文件 id=629 预览时，会看到 `assistant` 行里夹杂的 subagent 子轮（如 task tool 的输出）。这与索引时 `turn_count` 包含它们的行为一致，role 标签也已经能区分，**接受**。
- **现有用例回归**：`test/transcripts.scan.test.js` 现在没有 preview 模式用例，加新 case 不会影响存量；其他 transcript 相关测试（codex/cursor）路径不涉及 sidechain，零影响。
- **FTS 索引零变化**：`searchTranscripts` 调的是 `db.searchTranscripts`，FTS 内容是扫描时入库的，本次不重扫不重建。

## 验收

- 点预览 subagent 文件（如 `agent-a09fd29168e6cb0f0.jsonl` 对应记录）：能看到至少 1 条 user/assistant 内容，不再白屏。
- 点预览主会话 id=629：71 轮内容仍正常展示，可能多出 sidechain 轮次（预期之内）。
- 构造一个全是 meta / event 噪音的伪 jsonl（0 真实 turns），点预览：显示 `<Empty/>`，不白屏。
- 删掉文件后点预览（路由 404）：catch 弹 toast，modal 自动关闭，不留空壳。
- `npm test` 通过，新增的 sidechain 预览用例 GREEN。
