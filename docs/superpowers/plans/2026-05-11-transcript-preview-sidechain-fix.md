# Transcript 预览 — subagent 空白修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复在「历史会话找回」抽屉里点 subagent transcript 的「预览」按钮时弹窗空白的问题；同时给 modal 加 `<Empty/>` 兜底。

**Architecture:**
- 后端：`parseClaudeFile` 在 `preview=true` 模式下不再过滤 `isSidechain`，让 subagent jsonl（整文件 sidechain）能产出 turns。
- 前端：modal 内容区在 turn 数为 0 时显示 `<Empty/>`；preview API 抛错时同步关闭 modal 不留空壳。

**Tech Stack:** Node.js (better-sqlite3 + readline)、React 18 + Ant Design、Vitest。

**Spec:** `docs/superpowers/specs/2026-05-11-transcript-preview-sidechain-fix-design.md`

---

## 涉及文件总览

- **修改**：`src/transcripts/scanner.js`（删除 preview 模式下的 `isSidechain` 过滤）
- **修改**：`src/transcripts/index.js`（同步修正 preview 函数上方注释）
- **修改**：`web/src/transcripts/TranscriptSearchDrawer.tsx`（modal 加 Empty 兜底 + 错误时关 modal）
- **修改**：`test/transcripts.test.js`（更新 3 个既有 preview 用例 + 新增 1 个 subagent 用例）
- **修改**：`test/transcript-search-drawer-layout.test.js`（新增源码级回归用例）

---

## Task 1: 写失败测试 — parser 新语义

**Files:**
- Modify: `test/transcripts.test.js:135-150`（更新两条既有用例）
- Modify: `test/transcripts.test.js`（在 `describe('scanner preview mode'` 块内新增一条用例）

### 背景

`test/transcripts.test.js` 第 78 行起的 `describe('scanner preview mode', ...)` 现有 4 条用例。其中一条断言 `preview=true` 会过滤掉 `isSidechain` —— 这正是本次 bug 的"反向锁"。需要把它改成断言"sidechain 内容被**保留**"，再加一条用例覆盖 subagent 风格的全 sidechain 文件。

`writeClaudeRich` helper 写入的样本包含 1 行 `isSidechain: true` 的 assistant，目前是被过滤掉的（assistantTurns.length=2）。删过滤后该行会进入结果（assistantTurns.length=3），所以第 135 行的用例也要同步更新。

- [ ] **Step 1: 更新 "preview=true 保留 tool_use-only assistant turn 并渲染 🔧 摘要" 用例**

`test/transcripts.test.js:135-142` 现有内容：

```js
it('preview=true 保留 tool_use-only assistant turn 并渲染 🔧 摘要', async () => {
  const fp = writeClaudeRich(tmp, '/Users/me/proj')
  const r = await parseTranscriptFile('claude', fp, { preview: true })
  const assistantTurns = r.turns.filter(t => t.role === 'assistant')
  expect(assistantTurns.length).toBe(2)
  expect(assistantTurns[0].content).toContain('🔧 Bash: ls /tmp')
  expect(assistantTurns[1].content).toBe('🔧 Edit: /foo/bar.ts')
})
```

改为：

```js
it('preview=true 保留 tool_use-only assistant turn 并渲染 🔧 摘要', async () => {
  const fp = writeClaudeRich(tmp, '/Users/me/proj')
  const r = await parseTranscriptFile('claude', fp, { preview: true })
  const assistantTurns = r.turns.filter(t => t.role === 'assistant')
  // 3 = (text + tool_use 混合) + (sidechain 文本) + (纯 tool_use)
  expect(assistantTurns.length).toBe(3)
  expect(assistantTurns[0].content).toContain('🔧 Bash: ls /tmp')
  expect(assistantTurns[1].content).toBe('<sidechain-noise>')
  expect(assistantTurns[2].content).toBe('🔧 Edit: /foo/bar.ts')
})
```

- [ ] **Step 2: 替换 "preview=true 过滤 isMeta / isSidechain" 用例**

`test/transcripts.test.js:144-150` 现有内容：

```js
it('preview=true 过滤 isMeta / isSidechain', async () => {
  const fp = writeClaudeRich(tmp, '/Users/me/proj')
  const r = await parseTranscriptFile('claude', fp, { preview: true })
  const all = r.turns.map(t => t.content).join('\n')
  expect(all).not.toContain('<meta-noise>')
  expect(all).not.toContain('<sidechain-noise>')
})
```

替换为：

```js
it('preview=true 过滤 isMeta，但保留 isSidechain（subagent 内容）', async () => {
  const fp = writeClaudeRich(tmp, '/Users/me/proj')
  const r = await parseTranscriptFile('claude', fp, { preview: true })
  const all = r.turns.map(t => t.content).join('\n')
  expect(all).not.toContain('<meta-noise>')
  // sidechain 必须保留 —— 否则 subagent transcript 预览会全空
  expect(all).toContain('<sidechain-noise>')
})
```

- [ ] **Step 3: 新增 "subagent 风格全 sidechain 文件" 用例**

在 `describe('scanner preview mode', ...)` 块内（紧跟 Step 2 修改的用例之后）插入：

```js
it('preview=true 对全 sidechain 文件（subagent transcript）能解析出 turns', async () => {
  // 模拟 ~/.claude/projects/<encoded>/<uuid>/subagents/agent-*.jsonl
  // 这种文件每一行都是 isSidechain: true —— 旧实现会全部过滤掉，导致预览白屏。
  const uuid = 'subagnt-0000-0000-0000-000000000001'
  const encoded = '-Users-me-proj'
  const subDir = path.join(tmp, encoded, uuid, 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  const fp = path.join(subDir, 'agent-abc.jsonl')
  const lines = [
    { type: 'user', isSidechain: true, sessionId: uuid, timestamp: '2026-04-14T11:00:00.000Z',
      message: { role: 'user', content: 'subagent prompt' } },
    { type: 'assistant', isSidechain: true, sessionId: uuid, timestamp: '2026-04-14T11:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent reply' }] } },
  ]
  fs.writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n')

  const r = await parseTranscriptFile('claude', fp, { preview: true })
  expect(r.turns.length).toBe(2)
  expect(r.turns[0].role).toBe('user')
  expect(r.turns[0].content).toBe('subagent prompt')
  expect(r.turns[1].role).toBe('assistant')
  expect(r.turns[1].content).toBe('subagent reply')
})
```

- [ ] **Step 4: 跑测试，确认它们失败**

```bash
npm test -- test/transcripts.test.js
```

预期：
- "preview=true 保留 tool_use-only assistant turn …" FAIL（拿到 2，期望 3）
- "preview=true 过滤 isMeta，但保留 isSidechain …" FAIL（`<sidechain-noise>` 被过滤）
- "preview=true 对全 sidechain 文件 …" FAIL（`r.turns.length === 0`）

其他 preview 用例和默认模式用例应全 PASS。如果其它用例也 FAIL，停下来排查。

---

## Task 2: 修 parser，让上述测试转绿

**Files:**
- Modify: `src/transcripts/scanner.js:68-72`
- Modify: `src/transcripts/index.js:160`

- [ ] **Step 1: 删 `isSidechain` 过滤、改注释**

`src/transcripts/scanner.js:68-72` 现有内容：

```js
    // preview 模式：和 buildFullTranscript 对齐 —— 过滤 meta/sidechain，只取 user/assistant
    if (preview) {
      if (j.isMeta || j.isSidechain) continue
      if (j.type !== 'user' && j.type !== 'assistant') continue
    }
```

替换为：

```js
    // preview 模式：剔除 isMeta（local-command-caveat 等噪音）与非 user/assistant 类型。
    // 注意：不能过滤 isSidechain —— subagent transcript 文件全部是 sidechain，
    // 过滤后会变成空预览（与索引时 turn_count 不一致）。
    if (preview) {
      if (j.isMeta) continue
      if (j.type !== 'user' && j.type !== 'assistant') continue
    }
```

- [ ] **Step 2: 同步修正 index.js 的注释**

`src/transcripts/index.js:160` 现有内容：

```js
    // preview 模式：包含 tool_use / tool_result 摘要，过滤 isMeta/isSidechain；
    // index 模式（默认）保持纯文本以避免污染 FTS。
```

替换为：

```js
    // preview 模式：包含 tool_use / tool_result 摘要，过滤 isMeta（保留 isSidechain，
    // 否则 subagent transcript 文件会变成空预览）。
    // index 模式（默认）保持纯文本以避免污染 FTS。
```

- [ ] **Step 3: 跑 parser 相关测试，确认全绿**

```bash
npm test -- test/transcripts.test.js
```

预期：`test/transcripts.test.js` 全部 PASS（Task 1 新增的 3 处断言 + 其余既有用例）。

- [ ] **Step 4: 跑全量测试，确认无回归**

```bash
npm test
```

预期：全部 PASS。如有其它 transcript 相关用例红了，需要看是否是合理预期变更（例如 `transcripts service` 块里依赖 `turn_count` 的用例理论上不应受影响，因为索引走的是 `preview=false`）。

- [ ] **Step 5: 提交**

```bash
git add src/transcripts/scanner.js src/transcripts/index.js test/transcripts.test.js
git commit -m "$(cat <<'EOF'
fix(transcripts): keep sidechain in preview so subagent files render

Why: subagent transcript jsonl files are entirely isSidechain; the
preview filter was dropping every line, leaving the preview modal
blank. Index mode already keeps sidechain — preview now matches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 写失败测试 — 前端 Empty 兜底 + 错误关 modal

**Files:**
- Modify: `test/transcript-search-drawer-layout.test.js`

### 背景

现有 `test/transcript-search-drawer-layout.test.js` 是源码级"contains"断言（不渲染 React）。沿用同样模式来锁定本次新增的两点：

1. modal 内部有 `<Empty` 兜底分支
2. `handlePreview` catch 块里调用了 `setPreviewFile(null)`

- [ ] **Step 1: 新增一个 describe 块**

在文件末尾追加：

```js
describe('TranscriptSearchDrawer preview modal empty / error fallback', () => {
  it('shows <Empty/> when preview returns zero turns', () => {
    // 兜底分支：!previewLoading && previewTurns.length === 0 → 渲染 Empty
    expect(source).toMatch(/previewTurns\.length === 0[\s\S]*?<Empty/)
    expect(source).toContain('该会话暂无可展示内容')
  })

  it('closes preview modal when handlePreview throws', () => {
    // 在 handlePreview 的 catch 块里同步把 previewFile 置空，避免 API 失败后留白壳 modal。
    const handlePreviewMatch = source.match(/async function handlePreview[\s\S]*?\n  \}\n/)
    expect(handlePreviewMatch, 'handlePreview function not found').toBeTruthy()
    expect(handlePreviewMatch[0]).toMatch(/catch[\s\S]*?setPreviewFile\(null\)/)
  })
})
```

- [ ] **Step 2: 跑测试，确认两条新用例失败**

```bash
npm test -- test/transcript-search-drawer-layout.test.js
```

预期：
- "shows `<Empty/>` when preview returns zero turns" FAIL（modal 中不存在该兜底）
- "closes preview modal when handlePreview throws" FAIL（catch 块里没 `setPreviewFile(null)`）
- 既有 2 条 layout 用例 PASS。

---

## Task 4: 实现 Empty 兜底 + 错误关 modal

**Files:**
- Modify: `web/src/transcripts/TranscriptSearchDrawer.tsx:166-178`（`handlePreview` catch 块）
- Modify: `web/src/transcripts/TranscriptSearchDrawer.tsx:368-403`（modal 内容区）

- [ ] **Step 1: 在 handlePreview catch 块里关闭 modal**

`web/src/transcripts/TranscriptSearchDrawer.tsx:166-178` 现有内容：

```tsx
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
    } catch (e) { message.error((e as Error).message) }
    finally { setPreviewLoading(false) }
  }
```

替换为：

```tsx
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
      setPreviewFile(null)
    }
    finally { setPreviewLoading(false) }
  }
```

注意 `loadMorePreview`（同文件 180-189）的 catch 块**不动** —— 二次翻页失败时 modal 应保持开启，让用户看到已加载的部分。

- [ ] **Step 2: 在 modal 内容区加 Empty 兜底**

`web/src/transcripts/TranscriptSearchDrawer.tsx:368-403` 现有内容（删 `<Spin>` 内部全部主体并替换）：

```tsx
        <Spin spinning={previewLoading}>
          <div style={{ maxHeight: 480, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {previewTurns.map((t, i) => {
              const expanded = expandedTurns.has(i)
              const overflowed = t.content.length > TURN_COLLAPSE_CHARS
              const display = !expanded && overflowed ? t.content.slice(0, TURN_COLLAPSE_CHARS) : t.content
              const { color: borderColor, tagColor } = roleStyle(t.role)
              return (
                <div key={i} style={{ borderLeft: `3px solid ${borderColor}`, padding: '4px 8px' }}>
                  <Tag color={tagColor}>{t.role}</Tag>
                  <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 12 }}>
                    {display}
                    {!expanded && overflowed && '…'}
                  </pre>
                  {overflowed && (
                    <Button
                      size="small"
                      type="link"
                      style={{ padding: 0, marginTop: 2, fontSize: 12 }}
                      onClick={() => toggleTurnExpand(i)}
                    >
                      {expanded ? '收起' : `展开（${t.content.length - TURN_COLLAPSE_CHARS} 字隐藏）`}
                    </Button>
                  )}
                </div>
              )
            })}
            {previewTotal > previewTurns.length && (
              <div style={{ textAlign: 'center', padding: 8 }}>
                <Button size="small" loading={previewLoadingMore} onClick={loadMorePreview}>
                  加载更多 {Math.min(PREVIEW_PAGE_SIZE, previewTotal - previewTurns.length)} 条
                </Button>
              </div>
            )}
          </div>
        </Spin>
```

替换为：

```tsx
        <Spin spinning={previewLoading}>
          <div style={{ maxHeight: 480, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!previewLoading && previewTurns.length === 0 ? (
              <Empty description="该会话暂无可展示内容" />
            ) : (
              <>
                {previewTurns.map((t, i) => {
                  const expanded = expandedTurns.has(i)
                  const overflowed = t.content.length > TURN_COLLAPSE_CHARS
                  const display = !expanded && overflowed ? t.content.slice(0, TURN_COLLAPSE_CHARS) : t.content
                  const { color: borderColor, tagColor } = roleStyle(t.role)
                  return (
                    <div key={i} style={{ borderLeft: `3px solid ${borderColor}`, padding: '4px 8px' }}>
                      <Tag color={tagColor}>{t.role}</Tag>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 12 }}>
                        {display}
                        {!expanded && overflowed && '…'}
                      </pre>
                      {overflowed && (
                        <Button
                          size="small"
                          type="link"
                          style={{ padding: 0, marginTop: 2, fontSize: 12 }}
                          onClick={() => toggleTurnExpand(i)}
                        >
                          {expanded ? '收起' : `展开（${t.content.length - TURN_COLLAPSE_CHARS} 字隐藏）`}
                        </Button>
                      )}
                    </div>
                  )
                })}
                {previewTotal > previewTurns.length && (
                  <div style={{ textAlign: 'center', padding: 8 }}>
                    <Button size="small" loading={previewLoadingMore} onClick={loadMorePreview}>
                      加载更多 {Math.min(PREVIEW_PAGE_SIZE, previewTotal - previewTurns.length)} 条
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </Spin>
```

`Empty` 已经在文件顶部 import（line 2），无需新增 import。

- [ ] **Step 3: 跑前端回归测试，确认转绿**

```bash
npm test -- test/transcript-search-drawer-layout.test.js
```

预期：4 条用例全 PASS。

- [ ] **Step 4: 跑全量测试，确认无回归**

```bash
npm test
```

预期：所有 vitest 用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add web/src/transcripts/TranscriptSearchDrawer.tsx test/transcript-search-drawer-layout.test.js
git commit -m "$(cat <<'EOF'
fix(web): empty fallback + close preview modal on error

Why: when preview returns zero turns (genuinely empty or post-fix
edge cases), the modal used to render pure white. Show <Empty/>
instead. Also close the modal if the preview API throws, so a 404
doesn't leave a blank shell behind.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 端到端手测验证

**Files:** （仅验证，不改代码）

- [ ] **Step 1: 启动后端 + web 开发服务**

按项目惯例（参考 `claude-mira.sh` / `package.json`）启动：

```bash
npm start
```

或开发模式：

```bash
npm run dev
```

确认终端无错误日志，浏览器能打开 web UI（通常 `http://localhost:<port>`）。

- [ ] **Step 2: 验证 subagent transcript 预览不再白屏**

在 web UI 中：

1. 打开「历史会话找回」抽屉
2. 搜索框输入 `35bf6977`（截图复现用的 native_id 前缀）
3. 点任意一条 subagent 记录（搜索结果列表里 jsonl 路径含 `subagents/`、turn 数较小的那些）的「预览」
4. 断言：弹窗中可见至少 1 条 user/assistant 内容，role tag 正常着色，**不再白屏**

- [ ] **Step 3: 验证主会话预览仍正常**

1. 同搜索结果中，点 `id=629`（即 jsonl_path 直接是 `<uuid>.jsonl`、turn 数最大的一条）的「预览」
2. 断言：内容正常滚动、`已加载 X / 共 N 轮` 出现、分页按钮工作

- [ ] **Step 4: 验证 Empty 兜底（可选）**

构造性测试 —— 在 web UI 不容易直接造 0-turn 场景；可以临时把某个真实 jsonl 改名让 preview API 落 500，或直接：

```bash
# 在终端模拟一次错误预览（假设服务监听 3001）
curl -s 'http://localhost:3001/api/transcripts/9999999/preview?offset=0&limit=500'
# 预期：{"ok":false,"error":"not found"}（404）
```

然后在 UI 上点一条记录后，开发者工具里手改对应 fileId 触发同样的 404 —— 应该看到 antd 顶部红条 toast，modal 被关闭。

（如果手测条件不允许，跳过本步；自动化测试已在 Task 3 锁定了这两段源码逻辑。）

- [ ] **Step 5: 报告完成**

汇总：
- 修改的文件清单
- `npm test` 全绿截图/输出
- 复现路径手测结果（subagent 不再空、主会话不回归、Empty 兜底已加固）
- 仍需用户确认的事项（如有）

---

## 自查（已完成）

- ✅ Spec 全部条目都有对应任务：parser 修复（Task 2）、Empty 兜底（Task 4 Step 2）、错误关 modal（Task 4 Step 1）、新单测（Task 1 Step 3、Task 3 Step 1）。
- ✅ 无占位符、无"TBD"、无未定义类型/函数。
- ✅ 文件路径、行号、命令、预期输出全具体。
- ✅ 前后 task 引用的标识符一致（`previewFile` / `previewTurns` / `previewTotal` / `previewLoading` 均与现有代码一致）。
