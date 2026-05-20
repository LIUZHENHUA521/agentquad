# CommandPalette 跨会话 transcript 搜索

- 日期: 2026-05-20
- 状态: spec / 待实现
- 触发: 用户希望在命令面板里能像 `TranscriptView` 顶栏那样按关键词搜 AI 历史会话,命中后跳到 `SessionFocus` AI 面板详情,而不是只能从 `TranscriptSearchDrawer` 那个独立抽屉入口走。

## 背景

现状里的"AI 历史会话查找"分两处:

1. `TranscriptView`(`web/src/TranscriptView.tsx:1437`)顶栏的内嵌搜索条 — 关键词 + matches 计数 + ↑/↓ 跳。**只能搜当前已经打开的那一个 session**。
2. `TranscriptSearchDrawer`(`web/src/transcripts/TranscriptSearchDrawer.tsx`)右抽屉 — 跨所有 transcript 文件搜,带 tool / cwd / unbound 等 filter。功能全,但路径深,需要先点开抽屉。

用户想要的是把(2)的搜索能力下沉到 `CommandPalette`(`web/src/components/CommandPalette/CommandPalette.tsx`),命中后直接跳(1)那个 `SessionFocus` 详情看板,并且预填 keyword 让用户能立刻 ↑↓ 翻匹配项。

## 关键决策(已与用户对齐)

| 维度 | 决策 |
|---|---|
| 入口 | `CommandPalette` 顶部搜索框,新增一类结果 group「AI 历史会话」 |
| 搜索目标 | 跨所有 transcript 文件的 turns 文本(沿用现有 `GET /api/transcripts/search`) |
| 触发分流 | `< 3 字`只搜本地 todos(现状);`≥ 3 字`并发去搜 transcripts |
| 结果项展示 | 高亮 snippet(命中前后上下文) + 所属 todo 标题 + tool 图标 + 起始时间 |
| 命中回车 — 已绑定 | `openFocus(boundTodoId, sessionId)` 跳 `SessionFocus`「对话」tab,关键词透传给 `TranscriptView`,自动预填 |
| 命中回车 — 未绑定 | 弹绑定 picker(复用 `TranscriptSearchDrawer` 里那个绑定 modal,抽成共享组件),绑定成功后再跳 `SessionFocus` |
| 未绑定的命中 | 不过滤,仍展示;以"未绑定"灰色 tag 提示 |
| 跳过去后 keyword 高亮不到 | 仅预填,不强制 jumpToMatch,让用户看 ↑↓ 上的 `n/N` 数字判断 |
| 结果上限 | 命令面板 8 条(列宽有限);Drawer 维持 50 条不动 |
| 搜索 debounce | 250ms(与 Drawer 保持一致) |
| 已绑定 todo 已归档 | 后端 search 直接返回 `boundTodoTitle`,前端无需额外取归档 todo |

## 不在本次范围内

- Drawer 本身的功能不变(rescan / unboundOnly filter / preview modal / copy resume 等)。
- 后端 `searchTranscripts` SQL 的搜索算法(LIKE / FTS 分流)不动,只调 snippet 上下文宽度。
- 不引入新的 transcript 索引或 schema 迁移。
- 不做 sub-page 形态的"切换到会话搜索模式"。

## 架构

```
CommandPalette.tsx
 ├─ 现有 jumpToTodo group(本地 fuzzy)
 ├─ <TranscriptResultsGroup query={search} onPick={...} />        ← 新增
 │   └─ 内部: debounce 250ms → fetch searchTranscripts → 渲染 Command.Group
 ├─ 现有 quick actions / drawers / view / system groups
 └─ <BindTodoModal open={...} file={...} onBound={openFocus(...)} /> ← 抽出+复用
                                            ▲
                                            │ 同一个组件
                                            │
TranscriptSearchDrawer.tsx ── <BindTodoModal open={...} file={...} onBound={refresh} />
                                            │
                                            ▼
                                    bindTranscript(fileId, todoId)
                                    POST /api/transcripts/:fileId/bind
```

数据流:

1. 用户在 `CommandPalette` 输入 ≥ 3 字 → `TranscriptResultsGroup` 内部 debounce 250ms 后调 `searchTranscripts({ q, limit: 8 })`。
2. 后端 `db.searchTranscripts` 返回 `TranscriptFile[]`,每条带 `snippet`(含 `<mark>`)、`bound_todo_id`、新增 `bound_todo_title`。
3. 前端在 `Command.Group heading="AI 历史会话"` 下渲染,每条:
   - 高亮 snippet(`dangerouslySetInnerHTML`,沿用 Drawer 写法)
   - 所属 todo 标题(从 `bound_todo_title`;`null` 显示"未绑定" tag)
   - tool 图标(`<AgentIcon>`)
   - 时间(`started_at`)
4. 回车 → `onPick(file)`:
   - `bound_todo_id != null` → `useFocusStore.openFocus(boundTodoId, sessionId, { initialKeyword: q })` + `closePalette()`。
   - `bound_todo_id == null` → `setBindTarget(file)` 让 `BindTodoModal` 上来;modal 的 `onBound(todoId)` 内部:绑定成功 → `closePalette()` + `openFocus(todoId, sessionId, { initialKeyword: q })`。

## 组件清单

### 1. 后端:`src/db.js#searchTranscripts`

**改动:**
- 把 FTS 路径里 `snippet(transcript_fts, 0, '<mark>', '</mark>', '…', 16)` 的最后一个参数 16 → **32**(更宽的上下文)。
- 把 `<3 字` LIKE 路径里 `SUBSTR(tf.first_user_prompt, MAX(1, INSTR(...) - 16), 64)` 调成 `MAX(1, INSTR(...) - 24), 96`。
- 在主 SELECT 里 LEFT JOIN `todos` 表(`tf.bound_todo_id = todos.id`),把结果列 `bound_todo_title` 一起带回来,未绑定时为 NULL。
- 在 db 层的 row → object 映射处把这个字段加进返回结构(`bound_todo_title`)。

不动的地方:LIKE / FTS 的阈值;limit / offset 入参;现有过滤(tool / cwd / since / unboundOnly)。

### 2. 后端:`src/routes/transcripts.js`

不需要改 — `service.search` 直接转发给 `db.searchTranscripts`,返回字段自动多一个 `bound_todo_title`。

### 3. 前端 API:`web/src/api.ts`

`TranscriptFile` interface 加一个可选字段:

```ts
export interface TranscriptFile {
  // ...
  bound_todo_id: string | null
  bound_todo_title?: string | null    // 新增
  snippet?: string | null
}
```

### 4. 新文件:`web/src/transcripts/BindTodoModal.tsx`

从 `TranscriptSearchDrawer` 里抽出的共享绑定 modal。Props:

```ts
type Props = {
  open: boolean
  file: TranscriptFile | null
  preselectTodoId?: string | null
  todos: Todo[]                            // 由调用方传入,避免重复 fetch
  onClose: () => void
  onBound: (todoId: string) => void        // 绑定成功(含冲突 confirm 后强制)的回调
}
```

内部逻辑就是把 `TranscriptSearchDrawer` 里 `submitBind` + 那个 `<Modal><Select/></Modal>` 平移过来。冲突时弹二次确认 modal(沿用现有逻辑)。

### 5. 新文件:`web/src/components/CommandPalette/TranscriptResultsGroup.tsx`

```ts
type Props = {
  query: string                            // 来自 CommandPalette 的 search
  onPickBound: (file: TranscriptFile, query: string) => void
  onPickUnbound: (file: TranscriptFile) => void
}
```

职责:
- `query.trim().length < 3` → 不发请求,渲染 null(不出现 group)。
- ≥ 3 字 → debounce 250ms 后 `searchTranscripts({ q: query, limit: 8 })`。
- 用 `useRef` 存最后一次请求 epoch,回包时若 epoch 不匹配就丢弃(防止串台)。
- 渲染 `<Command.Group heading="AI 历史会话">`,每条 `<Command.Item value={...} onSelect={...}>`。
- loading 状态可以用一行轻量 placeholder(`「搜索中…」`),也可以不显示,debounce 已经足够短。

> 注:`cmdk` 的 `<Command.Item value>` 要包含 query 才能让 cmdk 自己的内部过滤不把后端结果错误过滤掉 — 这里给 `value={'transcript-' + fileId + '-' + query}`,确保跟当前 query 严格匹配,任何 query 变化触发的旧结果在 cmdk 那一层也不会被错误命中。

### 6. 改 `CommandPalette.tsx`

- 引入 `<TranscriptResultsGroup>` 嵌在「跳转待办」和「focusSession」group 之间(新建的"在制 focus session"在最上;命中 transcripts 是历史回看,排次)。
- 新增本地 state:`const [bindTarget, setBindTarget] = useState<{ file: TranscriptFile; query: string } | null>(null)`。
- 引入 `<BindTodoModal>`,挂在 palette overlay 外(避免 cmdk overlay 关闭联动)。
- `onPickBound`: `useFocusStore.openFocus(file.bound_todo_id, file.session_id_or_native_id, { initialKeyword: query })` + `closePalette()`。
- `onPickUnbound`: 先 `closePalette()`,再 `setBindTarget({ file, query })` 让 `BindTodoModal` 上来 — palette 已完成它的任务(用户挑了一条),后续绑定流程交给 modal,行为最直白。
- `BindTodoModal.onBound(todoId)`: `useFocusStore.openFocus(todoId, bindTarget.file.session_id_or_native_id, { initialKeyword: bindTarget.query })` + 清 bindTarget。

> `useFocusStore.openFocus(todoId, sessionId)` 当前没有 opts 参数,所以本设计明确:在 `focusStore` 里加 `pendingInitialKeyword: string | null` 字段,`openFocus` 增加可选第三参 `{ initialKeyword, initialTab }`;`SessionFocus` mount / focusedSessionId 变化时把 `pendingInitialKeyword` 透传给 `TranscriptView` 然后 store 里清空(consume 一次)。

### 7. 改 `web/src/store/focusStore.ts` & `SessionFocus.tsx` & `TranscriptView.tsx`

- `focusStore`:`openFocus(todoId, sessionId, opts?: { initialKeyword?: string; initialTab?: 'live' | 'conversation' })`;internal state 加 `pendingInitialKeyword`,`SessionFocus` 拿到后 consume(set 给 TranscriptView)。打开 `conversation` tab 而不是 live。
- `SessionFocus.tsx`:把 `pendingInitialKeyword` 透传给 `<SessionViewer>`,后者再透传给 `TranscriptView`。
- `TranscriptView.tsx`:加一个 `initialKeyword?: string` props,在 mount(或 sessionId 变化)时 `setKeyword(initialKeyword)`;**不**强制 `jumpToMatch(0)` — `matches` 是基于已渲染 turns 计算的,等用户主动按 ↑↓ 或 cmdk 已经做 `n/N` 显示就够了。

### 8. `TranscriptSearchDrawer.tsx`

把 `<Modal>` 那段绑定 UI 删掉,改用新的 `<BindTodoModal>` 共享组件。其它不变。

## 错误处理

| 场景 | 处理 |
|---|---|
| 后端搜索 5xx | `TranscriptResultsGroup` catch 后渲染 null(不打扰用户的本地 todo 搜索);console.error 留痕。不弹 `message.error` —— 否则每次敲键都弹,体验灾难。 |
| 绑定冲突(409) | 沿用现有 Drawer 逻辑:弹二次确认 modal "已绑定到 X,要改吗?" |
| 已绑定的 todo 已被归档 | `bound_todo_title` 仍能拿到(后端 LEFT JOIN);group item 正常显示。回车跳 `openFocus` 时,如果 `SessionFocus` 因为 todo 不在内存 todos 里失败,fallback 到 todoSnapshotStore — 这是现有的 fallback 路径。 |
| transcript 文件没 `native_id` 也没 `bound_todo_id` | 仍可以打开 SessionFocus(若有 sessionId);BindTodoModal 也能工作。 |
| 切换 query 后旧结果回包 | epoch 机制丢弃。`<Command.Item value=>` 也包含 query,作为第二道闸。 |

## 性能与边界

- `≥ 3 字` 阈值与现状 Drawer / db.js 完全一致,后端走 FTS 路径,典型 < 50ms。
- limit = 8(palette) vs 50(drawer):palette 列宽决定的视觉上限,且 cmdk fuzzy 高亮算法本身吃 CPU,8 条够用。
- snippet 上下文从 16→32 token / 64→96 字符,后端开销几乎为零(只是 SUBSTR 的截取长度变化),但用户能更清晰判断是否要跳。
- 关闭 palette 时,`TranscriptResultsGroup` 因 unmount 自然丢弃 in-flight(因为它在 palette 内,只有 palette open 时才 mount)。

## 测试

至少新增:

1. `test/web/transcript-results-group.test.tsx`(若现有前端测试基础架构允许,沿用现有 vitest 项目):
   - <3 字不发请求
   - ≥3 字 debounce 250ms 后发起一次
   - query 快速变化时,旧请求被丢弃(epoch)
   - 后端 5xx 时不抛、不弹 message、group 渲染为 null
2. 后端 `test/db.test.js` 或 `test/search.test.js`(若存在)加一个 `searchTranscripts` 用例,断言返回项含 `bound_todo_title` 字段。
3. 手测清单:
   - 打开命令面板,敲 < 3 字 → Network 面板无 `/api/transcripts/search` 请求
   - 敲 3 字 → 看到 group,选一条已绑定 → 跳 SessionFocus「对话」tab,顶栏搜索框已预填 keyword,`n/N` 数字非零
   - 选一条未绑定 → 弹绑定 modal,选 todo → 绑定成功后 SessionFocus 打开
   - Drawer 里走绑定流程(沿用新 BindTodoModal),不退步

## 验收标准

- [ ] 命令面板里输入 ≥3 字,「AI 历史会话」group 出现,带 snippet(含 `<mark>` 高亮)、所属 todo、tool 图标、起始时间
- [ ] 已绑定结果 → 回车 → 打开 SessionFocus「对话」tab,`TranscriptView` 顶栏搜索框预填了 query,`n/N` 数字显示
- [ ] 未绑定结果 → 回车 → 弹绑定 modal,选完 todo → 绑定成功 message + 自动 SessionFocus 打开
- [ ] <3 字时不发起后端请求(Network 面板可验证)
- [ ] query 快速变化时,旧请求结果不会回填到错误的 query 上(可在低速网络下手测)
- [ ] Drawer 的绑定流程(包括冲突 confirm)沿用新 BindTodoModal,行为不变
- [ ] 后端 search 响应里多了 `bound_todo_title` 字段;snippet 上下文宽度生效
- [ ] 至少 1 个新前端组件测试 + 1 个新后端断言

## 实现顺序提示(给 writing-plans 阶段参考)

1. 后端 `db.searchTranscripts` 调 snippet 宽度 + JOIN todos 取 title
2. `TranscriptFile` interface 加字段
3. 抽出 `BindTodoModal`,Drawer 切过去用(此步独立可发,不阻塞后续)
4. 加 `focusStore.openFocus(opts)` + pendingInitialKeyword consume
5. `TranscriptView` 接 `initialKeyword`
6. 新增 `TranscriptResultsGroup`
7. `CommandPalette` 嵌新 group + BindTodoModal
8. 测试 + 手测
