# Memory Wiki v2 — 设计文档

> 日期：2026-05-14
> 状态：Design / Pending review
> 作者：lzh（与 Claude brainstorm 产出）
> 灵感来源：
> - 老 spec：[2026-04-20 auto-wiki-memory](./2026-04-20-auto-wiki-memory-design.md)
> - [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)（Tauri/Rust 桌面 app）
> 触发：用户反馈"记忆 Wiki 用不上"

## 一、问题诊断

老版本（v1）实际上是一个**被动归档工具**，不是辅助用户工作的"记忆"。证据来自用户的实际数据：

- 04-23 跑过 1 次正式 batch，3 个 sources 写入 `~/.agentquad/wiki/sources/`，claude 退出码 0 ✅
- **但 `topics/` 和 `projects/` 完全为空，`index.md` 仍是占位符** ❌
- 也就是说"沉淀知识"这一步 claude 实际跑成功了，但因为 WIKI_GUIDE.md 第 4 条规则给了"如果琐碎可以跳过"的宽松退出条件，对 3 条素材判定为可跳过，**真的一页 topic 都没产出**

更深层的体验问题：

1. **入口门槛太高**：291 条已完成 todo 摆在那等用户勾选，像永远清不完的收件箱
2. **回报不可见**：哪怕沉淀成功，内容藏在 1100px 宽的 Drawer 里，平时不会主动打开
3. **没有正反馈循环**：新建/打开 todo 时不会自动提示"你以前做过类似的事，看记忆里的 X"
4. **手动批处理**：选 → 等 claude → 看结果，整个流程像运维任务，不是自然产物

**结论**：v1 的核心问题不是"功能少"，而是"价值闭环没跑通"——产出质量不稳定、产出没回到工作流中。本 spec 要解决的就是这两件事。

## 二、目标 & 非目标

### 目标
1. **产出稳定**：跑一次必有像样产出（实体页 / 概念页 / chores 兜底），不再出现"跑完一页 topic 都没生成"
2. **价值找上门**：新建/打开 todo 时，自动召回相关历史经验展示在 todo 详情面板，让用户即便不主动开 Drawer 也能受益
3. **沉淀过程不再是负担**：积压清零策略 + 半自动入队，让用户停止"凝视未沉淀列表"

### 非目标（v2 仍然不做）
- 不做知识图谱可视化（YAGNI；llm_wiki 的 sigma.js 图谱先不抄）
- 不做 Web 剪裁 / 浏览器插件
- 不做 wiki 内全文搜索（Ctrl+F 顶住）
- 不做多机同步（用户手动 push 到 private repo）
- 不做"自动跑 claude"（保留手动触发为 MVP；阶段 2 才考虑后台队列）

## 三、借鉴 nashsu/llm_wiki 的设计精华

不复用代码（技术栈不兼容：他们 Rust/Tauri/LanceDB，我们 Node/Express/sqlite），但复用以下设计：

| llm_wiki 设计 | 我们怎么落地 |
|---|---|
| **purpose.md**（用户可编辑的"研究目标"） | 写一份默认 purpose.md：「这个记忆库是给我开发工作流准备的，关注踩过的坑/可复用模式/项目结构/工具配置；琐碎事务（写邮件、买东西）不需要沉淀」。用户可改 |
| **schema.md**（结构规则） | 写一份默认 schema.md，明确：哪些目录有哪些类型的页（entities / concepts / projects），命名约定（kebab-case），引用约定（相对 markdown 链接） |
| **两阶段链式 prompt** | 我们用**单阶段 agentic prompt + 硬完成契约 + git-diff 验产**替代（理由见 §6.4 备注）。一次调用让 claude 在 wiki 目录里读写文件，完成契约：必须以"新增/更新 entities 或 concepts 页 ≥1"或"chores.md 新增行 ≥1"结束；跑完后用 `git diff --name-only` 校验是否真的产出了变更，没产出就把 run 标为 failed |
| **entities/ + concepts/** 分类 | 新增这两个目录与老的 topics/ 并存。LLM 默认产出到 entities/concepts；老 topics/ 留着不动，由用户后续手动迁移或自然衰减 |
| **chores 兜底** | 增加 `chores.md`：判定为琐碎的 todo 也归一行进去，不直接丢弃。**消除"跑完啥也没有"的失败感** |
| **检索召回链路** | 阶段 1 做关键词召回（标题/描述/page body 的 BM25 或简单分词匹配）；阶段 2 才加向量（sqlite-vec） |
| **图扩展 4 信号公式** | 阶段 2 才接入；MVP 不做 |
| **审查面板** | MVP 不做；阶段 1 只在 Drawer 里加"这次跑产出了哪些页"的清单，让用户能 1 屏看完一次跑的结果 |

## 四、分阶段路线图

```
阶段 0：诊断验证（0.5 天，先做，硬门控）
  ↓ 全部退出条件通过（见 §五）才进
阶段 1：MVP（实际工期 ~5 个工作日，见 §十拆分）
  - A 基础设施（DB 迁移 + purpose/schema 初始化 + schemaVersion 升级）— 0.5d
  - B 单阶段 prompt + 硬契约 + 失败重跑（产出稳定性）— 1.5d
  - C 召回 panel（recall.js + API + TodoManage Section C.5）— 1.5d
  - D 积压清零（dismiss-legacy 双向工具 + WikiDrawer 入口）— 0.5d
  - E 前端打磨 + i18n + 跑批 toast 详情化 — 0.5d
  ↓ 用户连续 2 周实际使用、召回 panel 有点击行为
阶段 2（可选）：向量召回 + 后台自动消化队列 + 审查面板
```

如果阶段 0 发现 LLM 从 todo 这种短文本里根本提炼不出有用的知识，**立即回退到方向 C**（用户完成 todo 时手写经验卡片），本 spec 作废。这是关键的"先验证再投入"门控。

## 五、阶段 0：诊断验证

### 目标
用半天，回答："改用单阶段 agentic prompt + 硬完成契约后，claude 能不能从用户的 todo 里产出像样的 entities/concepts？"——这是决定本 spec 整条路线是否值得做的硬门控。

### 做法
1. **写诊断脚本** `scripts/wiki-diagnose.js`（不动主代码）：
   - 复用现有 `src/wiki/sources.js` 生成 source markdown
   - 在临时目录 `~/.agentquad/wiki-diagnose-2026-05-14/` 中初始化一个干净的 wiki（git init + 写入新版 purpose.md / schema.md）
   - 用 §6.4 的新 prompt 跑一次 claude
2. **样本固定 N=10**：从用户 291 条未沉淀 done todo 里手动挑 10 条**非琐碎**（涉及 cloudbase 部署、AI 状态机、消息队列、终端键盘事件等技术类）；记录在诊断脚本头部，可重复
3. **跑前盲写期望**：跑脚本前，**用户先盲写**：每条 todo 列出 1-3 句"我希望从这条任务沉淀下来的可复用知识"。存到 `wiki-diagnose-expected-2026-05-14.md`
4. **跑脚本，看产出**
5. **对照评估**：把"用户盲写的期望"与"claude 产出的页面"逐条对照

### 退出条件（解 reviewer Issue 3，量化）

满足 **所有** 以下条件才进入阶段 1：

| 指标 | 阈值 | 测量 |
|---|---|---|
| 硬契约满足率 | 10/10 个 source 都被归入了 entity / concept / chore，没有"被忽略" | 看 git diff，每条 source 都对应一处下游变更 |
| 非琐碎覆盖 | 至少 7 条 source 进入 entities/concepts（不是 chores） | 数 chores.md 新增行数 ≤ 3 |
| 期望命中 | 至少 6/10 条 todo 的产出页面**覆盖了用户盲写期望中的 ≥ 1 点** | 用户逐条勾选 |
| 纯抄写检测 | "产出页面是源 todo title/description 的近似复述" ≤ 2 条 | 用户主观判断；超过即认为 LLM 在做翻译不是抽象 |
| 用户主观满意 | "我会愿意在下次类似 todo 时打开这一页吗" 至少 5/10 回答 yes | 用户回答 |

**任一指标不满足**：spec 作废，回到方向 C（用户完成 todo 时手写经验卡片）。**不允许"差不多就行，先试试阶段 1"**。理由：阶段 1 是 5 天工作量，赌不起。

### 验收
- 跑通脚本，产出落到 `~/.agentquad/wiki-diagnose-2026-05-14/`
- 期望盲写 + 对照评分表完整记录到 `docs/wiki-diagnose-2026-05-14-report.md`
- 评分表附明确通过 / 不通过 结论与下一步决定

## 六、阶段 1：MVP

### 6.1 目录结构变更

```
~/.agentquad/wiki/
├── .git/
├── WIKI_GUIDE.legacy.md  # （schemaVersion 1→2 时由 WIKI_GUIDE.md 重命名而来）
├── purpose.md            # 新增：用户可编辑的研究目标
├── schema.md             # 新增：结构规则
├── index.md              # 顶级导航（LLM 维护）
├── log.md                # 运行日志
├── entities/*.md         # 新增：工具/服务/库（"是什么"）
├── concepts/*.md         # 新增：模式/坑/经验（"怎么做/避免什么"）
├── chores.md             # 新增：琐碎事务一行一条
├── topics/*.md           # 保留：v1 老页面不动，但同主题写入时合并到此处（见 §6.4 提示词）
├── projects/*.md         # 保留：v1 行为不变（LLM 仍会维护项目摘要）
└── sources/*.md          # 保留：v1 行为不变
```

**理由**：选择"折中"方案（C），不强行迁移 v1 产出。entities/concepts 与 topics/projects 短期并存，让用户在使用中自然选择是否手动迁移 topics → entities/concepts。

### 6.1.1 WIKI_GUIDE.md → purpose/schema 升级（解 reviewer Issue 4）

旧 wiki 用户可能已经手动编辑过 `WIKI_GUIDE.md`，**不能让用户的修改被 v2 静默忽略**。schemaVersion 1→2 升级时：

1. 检查 `wikiDir/.agentquad-wiki-meta.json`（新增的元数据文件）的 `schemaVersion` 字段
2. 若 < 2：
   - 把现有 `WIKI_GUIDE.md` 重命名为 `WIKI_GUIDE.legacy.md`（git mv 保留历史）
   - 检测 `WIKI_GUIDE.legacy.md` 内容是否等于 v1 出厂默认 `WIKI_GUIDE_CONTENT` 字节相同
     - **相同**（用户没动过）→ 静默删除 `WIKI_GUIDE.legacy.md`
     - **不同**（用户改过）→ 保留，且在新写入的 `purpose.md` 顶部插入横幅：
       ```
       > **从 WIKI v1 升级提示**：你之前编辑过 WIKI_GUIDE.md，它已经被重命名为
       > WIKI_GUIDE.legacy.md。请把其中你自定义的规则手动迁移到当前 purpose.md
       > 或 schema.md，迁移完成后可以删除 WIKI_GUIDE.legacy.md。
       ```
3. 写入默认 `purpose.md` 与 `schema.md`（若不存在）
4. 写入 `.agentquad-wiki-meta.json` 标记 `schemaVersion: 2`、`upgradedAt: <ISO>`
5. 全部变更走一个 `git commit -m "wiki: upgrade schemaVersion 1→2"`

### 6.2 默认 purpose.md（程序首次写入）

```markdown
# Wiki Purpose

这是我（{username}）的工作记忆库。LLM 沉淀内容时请遵循以下意图：

## 我关心什么
- 踩过的坑 + 解决方案（命令行参数、依赖版本陷阱、API 边界）
- 可复用的模式（项目骨架、配置模板、调试技巧）
- 工具与服务的关键事实（API 文档要点、CLI 常用命令、错误码含义）
- 项目结构摘要（每个 workDir 对应项目是干嘛的、关键目录）

## 我不关心什么
- 日常事务（买东西、写邮件、约会、提醒）→ 这类只在 chores.md 留一行
- 一次性脚本的具体输出（保留在 sources/ 即可，不要复制到 entities/concepts）
- 我个人的隐私信息（密钥、密码、身份信息）

## 语言
中文优先，代码/命令/路径保留原文。
```

### 6.3 默认 schema.md（程序首次写入）

```markdown
# Wiki Schema

## 页面类型
- `entities/<kebab>.md` — "是什么"。一个工具/库/服务/概念一页。例子：`cloudbase-functions.md`、`xterm-js.md`、`anthropic-sdk.md`
- `concepts/<kebab>.md` — "怎么做 / 避免什么"。一个模式或踩坑一页。例子：`websocket-keepalive-pattern.md`、`monorepo-shared-deps-pitfall.md`
- `projects/<kebab>.md` — 一个 workDir 对应一页项目摘要（LLM 自动生成，含该项目沉淀过的页面列表）
- `chores.md` — 琐碎事务的归档，一行一条，不展开

## 页面结构（entities/concepts 必须满足）
```
---
title: <人类可读标题>
type: entity | concept
tags: [tag1, tag2]
sources: [sources/2026-04-23-abc.md, ...]
---

# <title>

## 摘要（1-2 句）

## 关键事实 / 步骤
（条目，不超过 1 屏；超出就拆页）

## 关联
- [[../entities/foo]]
- [[../concepts/bar]]
```

## 强制规则
- LLM 每次跑必须产出至少 1 个新建/更新的 entity 或 concept 页面，**或**在 chores.md 追加一行。不能"什么都不写"
- 单页超过 ~3KB 就要考虑拆页
- 引用其他页用相对 markdown 链接
```

### 6.4 单阶段 Agentic Prompt 设计

**备注 / 为何不用两阶段 JSON**：

调研后放弃两阶段 + JSON 中间表示的方案。原因：
- `claude --output-format json` 是把模型回答**包**在 JSON 外壳里，不约束模型本身输出 JSON。要让模型严格 JSON 需要 `--json-schema`，但该 flag 不一定所有 claude CLI 版本可用，可移植性差。
- 我们的 `defaultExecClaude` 已经是非交互 batch，claude code 本身就有 Read/Write/Edit 工具，单阶段直接让它在 wiki 目录读写文件最符合工具习惯，比"JSON 中间表示 + 第二阶段重新读盘"省一次 LLM 调用、省 token、少一处解析失败点。
- 控制产出稳定性的关键是**硬完成契约 + 客观验产**，不是"先决策再执行"。

**单阶段 prompt**（替换 `src/wiki/index.js` 现有 `buildClaudePrompt`）：

```
你正在维护用户的工作记忆 wiki。当前 cwd 已经是 wiki 根目录，你可以直接用 Read/Write/Edit 工具读写文件。

## 读取（必须按顺序读完再开始写）
1. purpose.md — 用户的研究意图
2. schema.md — 页面结构规则
3. index.md — 现有页面索引（如非空）

## 本批输入
sources/ 下这些新文件是本次要处理的素材：
- sources/2026-05-14-abc.md
- sources/2026-05-14-def.md
...
（注意：sources/*.md 是输入，永远不要修改）

## 你的任务
为每条 source 选择**恰好一个**归属：
- entity（"是什么"类，落到 entities/<kebab>.md）
- concept（"怎么做/避免什么"类，落到 concepts/<kebab>.md）
- chore（琐碎事务，追加一行到 chores.md，不为它建独立页）

写文件时遵循：
- entity / concept 页满足 schema.md 中的 frontmatter + 章节结构
- 同主题已存在的页（含老的 topics/*.md）→ 在已存在的页上追加/合并；不要新建同主题页
- 关联用相对 markdown 链接：[[../entities/foo]] 或 [[../concepts/bar]]

最后：
- 更新 index.md：列出 entities/ + concepts/ + projects/ + topics/ 下所有页面（按目录分组，每组字母序）
- 追加 log.md：一段 ## YYYY-MM-DD HH:MM，列出你本次新建/修改的每个页面（每行一句话）

## 硬完成契约（必须满足，否则本次跑会被判失败）
**你必须以 git diff 至少 1 个非 sources 文件结束**。具体：
- 至少新建或修改 1 个 entities/*.md 或 concepts/*.md，**或**
- 至少向 chores.md 追加 1 行

不允许"全部判定为琐碎且不写任何文件"。判定为琐碎时也必须落到 chores.md。

## 不要做
- 不要修改 sources/*.md
- 不要在终端打印总结（你的输出会被丢弃；改动通过文件落地）
- 不要主动跑 git 命令（runner 会在你完成后统一 commit）
```

**调用方式 & 工具权限**（落到 `src/wiki/index.js`）：

- 仍然 `claude -p --output-format text`（envelope 不重要，我们只看 exitCode 和文件 diff）
- 新增 `--permission-mode bypassPermissions`（batch 场景没人按确认），由 `config.wiki.permissionMode` 暴露允许覆盖（默认 `bypassPermissions`，谨慎用户可改 `acceptEdits`）
- 不显式 `--allowedTools`；默认工具集已含 Read/Write/Edit/Glob/Grep，足够用

**post-run 验产**（在 `gitCommit` 前执行）：

```js
const { stdout } = await execFileP('git', ['diff', '--name-only', 'HEAD'], { cwd: wikiDir })
const changed = stdout.split('\n').filter(Boolean)
const productive = changed.some(p =>
  p.startsWith('entities/') || p.startsWith('concepts/') || p === 'chores.md'
)
if (!productive) {
  throw new Error('wiki run failed contract: 0 entities/concepts/chores changes')
}
```

失败时不 commit，但也不主动 reset（保留 sources 文件用于调试 / 下次重跑）。`wiki_runs.error` 记录"硬契约未满足"。前端 toast 显示明确的失败原因（不是"claude 跑成功了但啥也没产出"）。

### 6.5 召回 panel（todo 详情侧栏）

**触发**：打开任意 todo 详情时，后端用 todo 的 title + description 对 wiki 做关键词检索（v1 不上向量）。

**检索算法（MVP）**：
1. 把 `entities/` + `concepts/` + `topics/`（兼容老页面）下所有 `.md` 加载到内存索引
2. 对查询字符串和每个页面，分词：
   - 中文：`Intl.Segmenter`（Node 18+ 自带）
   - 英文：按空格 + 小写化
3. 打分：匹配词在 title / frontmatter title / body 的命中次数加权（title × 3、frontmatter title × 2、body × 1），归一化到 [0, 1]
4. 返回 top-K 分数 ≥ `recallMinScore` 的页面

**索引生命周期（解 reviewer Issue 5）**：

| 事件 | 行为 |
|---|---|
| 服务启动 | 全量扫描 entities/ + concepts/ + topics/，构建内存索引 |
| `runOnce` 开始 | 索引"冻结"——任何 recall 请求**仍然返回当前索引快照**，不读盘 |
| `runOnce` 成功 commit 后 | 用 commit 后的 HEAD 列出的相关 .md 文件**增量**更新索引（只重读 diff 涉及的文件） |
| `runOnce` 失败 | 不更新索引（保持冻结前的快照） |
| 用户手动编辑了 wiki 文件 | 每 30s 一次 mtime 扫描兜底；发现 .md mtime 变化则重新读这一个文件并更新索引 |
| 页面总数 > 500 | 触发"降级模式"：只索引 title + frontmatter，不索引 body；前端 toast 提示 |

**为什么不读 mid-run 的工作树**：mid-run 时 claude 正在写文件，读到的可能是半写状态。统一从 git HEAD 视角看（提交了才算"已沉淀"），避免脏读。具体到实现，索引读取的是 `git show HEAD:<path>` 或在 commit 之后再扫一次，不是读盘。

**UI（todo 详情抽屉，section C 之后插入新 Section C.5"相关记忆"）**：

精确插入点：`web/src/TodoManage.tsx:1502` 的 `{/* Section C — description card */}` 段之后、`{/* Section D — comments */}` 段之前。

```
[相关记忆]
🔹 cloudbase-functions — 03-15 沉淀 ★ 匹配 4 词
   云函数部署与 cloudbaserc.json 配置...

🔹 websocket-keepalive-pattern — 04-02 沉淀 ★ 匹配 2 词
   PVP 服务保活与跨实例广播...
```

- 默认 collapsed=false（展开），但**只在 hits.length > 0 时整个 Section C.5 才渲染**——没命中就完全不占位
- 加载态：detail 打开后立即异步请求 `GET /api/wiki/recall?todoId=xxx`，结果返回前 Section C.5 不渲染（不画 skeleton 占位，避免抖动）
- 点击页面卡片 → 打开 WikiDrawer 并定位到该页（前端 store 跨组件传递 `targetPath`）
- 点击"沉淀到记忆"按钮成功后：触发 recall 重新请求（refetch），让用户立刻看到刚沉淀进去的新页面被召回（正反馈循环关键一步）
- 配置：`config.wiki.recallEnabled = true`（默认开），用户嫌烦可关

**TodoManage.tsx 已经 1700+ 行**，本次增量保持就地插入，**不**强制做大重构（提取 `TodoDetailDrawer.tsx` 是 nice-to-have，留给后续独立任务）。

### 6.6 修复版 wiki 跑批流程

把 `src/wiki/index.js` 的 `runOnce` 改造：

1. 写 sources（与 v1 相同）
2. dry-run 时跳过 LLM（不变）
3. **正式跑改为单阶段 agentic**：
   a. 用 §6.4 的新 prompt 调一次 claude（`bypassPermissions`、cwd=wikiDir）
   b. claude 通过工具调用直接读写 entities/concepts/chores/index/log
4. **post-run 硬契约校验**：`git diff --name-only` 必须包含至少 1 个非 sources 路径（entities/concepts/chores.md）；否则视为失败，不 commit
5. 通过 → `git add -A && git commit`；从 commit 的 diff 反算 `produced`（统计新增/修改的 entities/concepts 路径列表 + chores.md 行数增量）
6. **返回值**：`{ runId, dryRun, exitCode, produced: { newEntities: [...], updatedEntities: [...], newConcepts: [...], updatedConcepts: [...], choresAppended: number } }`
7. 失败时（claude exitCode !=0、或硬契约未满足、或 git 操作出错）：保留 sources 与未 commit 的工作目录变更（用户可去 wiki dir 手动 `git diff` 看 claude 实际写了啥），`wiki_runs.error` 记录失败原因；下次跑批前会用 `git stash --include-untracked` 清场（见 §6.6.1）

### 6.6.1 失败重跑 / orphan sources 处理

reviewer Issue 10：失败的 run 会留下 `sources/YYYY-MM-DD-<short>.md` 文件，下次同日重跑同一条 todo 会覆盖。处理策略：

- **sourceFileName 加 run-id 后缀**：从 `YYYY-MM-DD-<todoShort>.md` 改为 `YYYY-MM-DD-<todoShort>-r<runId>.md`，确保不同 run 产出的 source 文件不互相覆盖
- **runOnce 启动时清场**：如果 wiki 目录有未提交变更（上次 run 失败留下的脏 working tree），执行 `git stash --include-untracked -m "wiki-recovery-<timestamp>"` 把它们藏起来，保留可恢复路径但不污染本次 run
- **启动时孤儿 run 标失败**（v1 已有 `markOrphansAsFailed`）继续保留

### 6.7 积压处理（291 条）

提供一次性脚本 `npm run wiki:dismiss-legacy`：

**步骤**：

1. **总是先 dry-run**：默认 `--dry-run` 行为，打印将被忽略的 todo 列表（id + title + completedAt）让用户预览
2. 用户加 `--commit` 才真正写入
3. 真正执行时：
   a. 在 `wiki_runs` 插入一条 synthetic run：`note='legacy-dismissed-migration-<YYYY-MM-DD>'`、`dry_run=0`、`exit_code=0`、`completed_at=now`
   b. 对每条需忽略的 todo，写入 `wiki_todo_coverage(wiki_run_id, todo_id, source_path=NULL, llm_applied=2)`
   c. 同时把所有被忽略的 todo 序列化到 manifest 文件：`~/.agentquad/wiki/dismissed-legacy-<YYYY-MM-DD>.json`
      ```json
      {
        "dismissedAt": "2026-05-14T...",
        "wikiRunId": 17,
        "todos": [
          { "id": "...", "title": "...", "completedAt": 1745... },
          ...
        ]
      }
      ```
      manifest 也 git commit 进 wiki repo（方便回溯）
4. **可逆**：提供 `npm run wiki:undismiss-legacy [todoId...]`
   - 不指定 id：清掉最近一次 manifest 中**全部**的 legacy-dismissed 标记
   - 指定 id：只清掉这几条；剩下的仍保持 dismissed
   - 清除方式：删除 `wiki_todo_coverage` 中 `wiki_run_id = <manifest 中的 runId>` 的对应行
   - 被恢复的 todo 重新出现在"未沉淀"列表
5. 这些 todo 之后不会再出现在"未沉淀"列表里
6. WikiDrawer 增加「从已忽略中挑选沉淀」次要入口：列出 manifest 中的 todo，多选 → 触发标准 `runOnce`（流程同正常批处理）
7. 之后只有"今天起新完成"的 todo 自动入队

**理由**：291 条积压的心理负担远大于其知识价值。从今天开始重新累积，质量优先。manifest + undo 命令避免单向门。

### 6.8 配置变更

```json
"wiki": {
  "wikiDir": "~/.agentquad/wiki",
  "maxTailTurns": 20,
  "tool": "claude",
  "timeoutMs": 600000,
  "redact": true,
  "recallEnabled": true,
  "recallTopK": 3,
  "recallMinScore": 0.2,
  "schemaVersion": 2
}
```

`schemaVersion=2` 用于检测老版本 wiki 目录并触发"补写 purpose.md / schema.md"（不动其他文件）。

### 6.9 DB 变更

```sql
-- wiki_todo_coverage 的 llm_applied 列扩展取值：
-- 0: dry-run only
-- 1: LLM 正式跑过
-- 2: legacy-dismissed（积压清零标记，可通过 npm run wiki:undismiss-legacy 撤销）

-- 新增：保存从 commit diff 计算出的产出摘要
ALTER TABLE wiki_runs ADD COLUMN produced_summary_json TEXT;
```

（去掉了原本拟添的 `stage1_decisions_json`——单阶段方案不再需要）

### 6.10 API 变更

| Method | Path | 变更 |
|---|---|---|
| GET | `/api/wiki/status` | 返回值增加 `schemaVersion`、`purposeExists`、`schemaExists` |
| GET | `/api/wiki/pending` | 不变，但默认过滤掉 `llm_applied=2`（legacy-dismissed） |
| GET | `/api/wiki/recall` | 新增：`?todoId=xxx` 或 `?q=xxx`，返回 top-K 相关页面 `[{ path, title, score, snippet }]` |
| POST | `/api/wiki/run` | 返回值结构变更：`{ runId, dryRun, exitCode, produced: { entities: [...], concepts: [...], choresAppended: number } }` |
| POST | `/api/wiki/dismiss-legacy` | 新增：批量标记积压为 legacy-dismissed |

### 6.11 前端变更

1. **TodoDetail 抽屉**：新增"相关记忆"区块（§6.5）
2. **WikiDrawer**：
   - 顶栏增加"打开 purpose.md / schema.md"快捷按钮（教用户怎么调整意图）
   - 跑批成功后的 toast 改为详细的"本次产出 N entities / M concepts / K chores"
   - 树形导航增加 entities/ 和 concepts/ 分组
   - 新增"从已忽略中挑选沉淀"次要入口
3. **i18n**：zh-CN / en-US 新增对应文案

## 七、阶段 2（可选，不在 MVP 范围）

- 向量召回：sqlite-vec 或 `@xenova/transformers`（本地嵌入）替换关键词检索
- 后台自动消化队列：done todo 默认入队，每天 N 条限速自动跑（用户可关）
- 审查面板：第一阶段 JSON 低置信度的让用户在 UI 上修正后才进第二阶段
- 知识图谱可视化：sigma.js + graphology（如果用户真的会看）

进入阶段 2 的前提：用户连续 2 周实际使用阶段 1 的 MVP，召回 panel 有可观察的点击行为。

## 八、风险与缓解

| 风险 | 缓解 |
|---|---|
| 阶段 0 发现 LLM 提炼能力不足 | 这本身就是 spec 设计的退出门；§五的 5 项硬指标全过才能进阶段 1，**不允许"差不多就上"** |
| 单阶段 prompt 不调工具直接给文本回答 | 硬契约校验：post-run 用 `git diff --name-only` 验是否有 entities/concepts/chores 变更，没变更直接标 failed；用户在前端看到明确错误而不是误以为"沉淀成功" |
| claude 把 wiki 改乱 | sources 文件名带 run-id 后缀避免覆盖；上次失败留下的脏 working tree 在下次 runOnce 时 `git stash` 保留可恢复；正常 commit 后用户可 `git reset --hard HEAD~1` 回滚 |
| WIKI_GUIDE.md 用户自定义规则升级时被无声覆盖 | §6.1.1 升级流程：检测内容是否被用户改过，改过则保留为 WIKI_GUIDE.legacy.md + purpose.md 顶部插横幅 |
| 关键词召回噪声大 | 设阈值 `recallMinScore`，调到只展示高置信度结果；用户实际反馈再调 |
| 召回索引 mid-run 脏读 | §6.5 索引生命周期：runOnce 期间索引冻结，commit 后增量更新；不读 working tree |
| 召回 panel 影响 todo 详情打开速度 | 召回 API 异步请求；hits.length===0 时整个 Section C.5 不渲染（不画 skeleton），无抖动；检索本身在内存索引完成 <10ms |
| dismiss-legacy 一键不可逆 | dry-run 默认；manifest 文件 + git commit 保留可追溯；`npm run wiki:undismiss-legacy` 支持全量/精确撤回 |
| schemaVersion=2 升级与已有 wiki 冲突 | 只补写不覆盖；走 `.agentquad-wiki-meta.json` 显式版本标记 |

## 九、验收标准

### 阶段 0 验收
- [ ] 跑通诊断脚本，产出落到 `~/.agentquad/wiki-diagnose-2026-05-14/`
- [ ] 用户对每个产出页面打分（有用/凑合/没用）；至少 5/N 页面用户认为"对未来工作有参考价值"才能进入阶段 1

### 阶段 1 验收（MVP）

**升级与初始化**：
- [ ] 启动时若 wiki 已存在且 schemaVersion<2 → 自动补写 purpose.md / schema.md，不动其他文件
- [ ] 如果用户编辑过 WIKI_GUIDE.md（与默认内容不一致）→ 重命名为 WIKI_GUIDE.legacy.md，在 purpose.md 顶部插入迁移横幅；用户没编辑过则静默删除 legacy 文件
- [ ] `.agentquad-wiki-meta.json` 记录 schemaVersion=2 与 upgradedAt 时间戳

**跑批稳定性（硬契约）**：
- [ ] 选 5 条新 done todo 跑批 → 必有 entities/concepts/chores 至少一类产出；不存在"跑完 0 页变更"
- [ ] 故意造 case（让 claude 把所有都判定为琐碎）→ 强制至少一行进 chores.md；硬契约校验通过
- [ ] claude 真的什么都没改的退化情况（模型 hallucination 不调工具）→ 硬契约检测到 0 个非 sources 文件变更 → run 标失败、不 commit、wiki_runs.error 记录"hard contract violated"

**跑批结果可见性**：
- [ ] 跑批结果 toast 显示"本次新增 N entities、M concepts、K chores"，数字来自 git diff
- [ ] WikiDrawer 顶栏"上次运行"信息包含产出摘要

**召回 panel**：
- [ ] 打开任意 todo 详情 → 如果 wiki 中存在相关页，"相关记忆"区块（Section C.5，位置在 description 与 comments 之间）显示 top-K 命中；hits 为空时整个 Section C.5 不渲染（不占位）
- [ ] 点击相关记忆卡片 → WikiDrawer 打开并定位到该页（store 跨组件传 targetPath）
- [ ] 点击"沉淀到记忆"按钮后 → 召回结果自动 refetch，新沉淀的页面立即出现在"相关记忆"列表

**索引生命周期**：
- [ ] runOnce 进行中：召回 API 返回的是 run 开始前的快照，不读盘
- [ ] runOnce 成功 commit 后：索引增量更新，下一次召回请求能看到新 commit 的内容
- [ ] 用户在外部手动编辑 wiki 文件 → 30s 内被 mtime 扫描捕获并反映到召回结果

**积压清零（dismiss-legacy 可逆性）**：
- [ ] `npm run wiki:dismiss-legacy`（无 `--commit`）只打印列表，不写 DB、不写 manifest
- [ ] `npm run wiki:dismiss-legacy --commit` 写 synthetic wiki_run + coverage 行 + manifest 文件 + git commit manifest
- [ ] 跑完后"未沉淀"列表清零
- [ ] `npm run wiki:undismiss-legacy` 全量撤回 → "未沉淀"列表恢复
- [ ] `npm run wiki:undismiss-legacy <id1> <id2>` 精确撤回指定 todo

**配置 / 错误处理**：
- [ ] purpose.md / schema.md 被用户修改后，下次跑批使用用户编辑后的版本
- [ ] entities/ 和 concepts/ 下产出的页面满足 schema 结构（含 frontmatter、章节、关联链接）
- [ ] 老的 topics/ 和 projects/ 在新跑批中不被破坏
- [ ] claude exit code != 0 → wiki_runs 标失败、UI 显示错误并提供重试、未提交的脏 working tree 在下次 runOnce 时被 stash 保存
- [ ] 同主题命名冲突：claude 把内容写入了已存在的 topics/xxx.md，没新建 entities/xxx.md

## 十、阶段划分（详细拆分留给 writing-plans）

总工期：阶段 0（0.5d 硬门控）+ 阶段 1（≈5d MVP）。按依赖：

1. **阶段 0（0.5d）**：写 `scripts/wiki-diagnose.js` 跑诊断 + 用户填评分表；通过 §五硬指标才进阶段 1
2. **阶段 1.A 基础设施（0.5d）**：
   - 在 `src/wiki/guide.js` 增加 PURPOSE_CONTENT / SCHEMA_CONTENT 常量
   - `src/wiki/index.js` 的 init 实现 §6.1.1 schemaVersion 1→2 升级逻辑（检测自定义 WIKI_GUIDE.md、迁移、写元数据）
   - DB 迁移：扩展 llm_applied=2 取值、添加 produced_summary_json 列
3. **阶段 1.B 单阶段 prompt + 硬契约（1.5d，prompt 迭代占大头）**：
   - 改造 `buildClaudePrompt` 为 §6.4 新版（含 schema 注入、页面索引注入、硬契约段）
   - `runOnce` 增加 stash 清场 + post-run git-diff 校验 + produced 反算
   - sourceFileName 加 run-id 后缀
   - 失败路径完整测试（claude 不调工具 / claude exit !=0 / 硬契约未满足 各一个测试）
4. **阶段 1.C 召回（1.5d）**：
   - 新增 `src/wiki/recall.js`：构建/增量更新内存索引（含 §6.5 生命周期）、关键词检索打分
   - 新增 `GET /api/wiki/recall` 路由
   - 前端 `TodoManage.tsx` 在 §6.5 指定位置（Section C 之后、Section D 之前）插入"相关记忆"区块
   - WikiDrawer 接入 `targetPath` store 跨组件传参
5. **阶段 1.D 积压处理（0.5d）**：
   - 新增 `scripts/wiki-dismiss-legacy.js`（默认 `--dry-run`、`--commit` 才实写、写 manifest、git commit manifest）
   - 新增 `scripts/wiki-undismiss-legacy.js`（全量 / 指定 id 撤回）
   - 新增 `POST /api/wiki/dismiss-legacy` 路由（封装上面的脚本逻辑，供 UI 调用）
   - 前端 WikiDrawer 增加"从已忽略中挑选沉淀"次要入口
6. **阶段 1.E 前端打磨 + i18n（0.5d）**：
   - WikiDrawer 树形导航增加 entities/concepts 分组（topics/projects 也保留）
   - 跑批成功 toast 显示 produced 详情
   - WikiDrawer 顶栏增加"打开 purpose.md / schema.md"快捷按钮
   - en-US / zh-CN 文案补齐

## 十一、已关闭的决策（开始实施前定调）

reviewer Issue 9 指出几个"开放问题"会回过头来影响契约，提前定调：

1. **页面索引注入上限**：单阶段 prompt 中"现有页面索引"以**filename + frontmatter title** 列表注入；超过 200 个时按文件名 kebab token 与本批 sources 的 token 做 Jaccard 相似度匹配，取 top 200 注入。避免 prompt 无限膨胀。
2. **同主题命名冲突优先级**：当 claude 准备新建 `entities/cloudbase-functions.md` 但 `topics/cloudbase-functions.md` 已存在 → §6.4 prompt 中明确要求"同主题已存在的页（含老的 topics/*.md）→ 在已存在的页上追加/合并；不要新建同主题页"。LLM 自己判定与合并；用户后续可手动迁移老页面命名到 entities/concepts。**不做自动迁移工具**。
3. **召回算法选型**：MVP 用"匹配词数 + 位置加权"打分（§6.5）；质量不够再换 BM25。**不进 MVP 的事**：向量、语义高亮。
4. **中文分词**：`Intl.Segmenter`（Node 18+ 自带，零依赖）。失败时降级为 bigram。
5. **召回结果展示内容**：返回 `{ path, title (来自 frontmatter), score, snippet (页面首段) }`。前端展示 title + snippet 截断到 80 字符。

## 十二、剩余开放问题（实施时可酌情决策，但不阻塞）

- 跑批进度推送：MVP 用前端 1-2s 轮询 `/api/wiki/status`；后期接 WS（v1 spec 同样的态度）
- `maxTailTurns=20` 是不是合适，跑起来看实际效果再调
- 召回索引降级模式（>500 页时的 toast 文案与启用条件）
