# Todo Stage Tags

给每条 todo 增加一个独立的"阶段标签"维度，跟现有的 `status`/`done` 完全正交。

用户场景："开发完了但还没测试 / 没发布"——单看 done 勾选反映不出来这种中间态。

---

## 决策摘要（brainstorm 锁定项）

| # | 决策 | 选项 |
|---|---|---|
| 1 | 标签和现有 done 状态的关系 | **A**：完全正交，独立字段 |
| 2 | 枚举 vs 自定义 | **A**：固定枚举，5 个标签 |
| 3 | 标签数量 | **A**：单选 + 可空（NULL = 无标签） |
| 4 | UI 入口 | **C**：卡片 chip + 详情面板，两边同步 |
| 5 | 筛选 | 不做 |
| 6 | 子 todo | A：子 todo 也可独立挂标签 |

---

## 标签集（最终 5 个）

| key | label | emoji | 用途 |
|---|---|---|---|
| `dev` | 待开发 | 🔧 | 还没动手 |
| `review` | 待评审 | 👀 | 代码 review / PR 等人看 |
| `test` | 待测试 | 🧪 | 开发完，等测试 |
| `release` | 待发布 | 🚀 | 测过了，等上线 |
| `blocked` | 阻塞中 | ⛔ | 等依赖 / 等他人，自己推不动 |

排序按流水线方向（dev → review → test → release → blocked），下拉菜单同序。

---

## § 1. 数据模型

`todos` 表新增一列：

```sql
ALTER TABLE todos ADD COLUMN stage_tag TEXT;
-- 取值：'dev' | 'review' | 'test' | 'release' | 'blocked' | NULL
-- NULL = 无标签（默认）
```

- 字段名 `stage_tag`（snake_case，与表内其他字段一致）。
- 不加 CHECK 约束（沿用现有表风格），合法性靠 API 层白名单拦。
- 不加索引（不筛选用不上）。
- 现存 todo 全部默认 `NULL`，旧数据零改动。
- SQLite 的 `ALTER TABLE ADD COLUMN`（带 nullable）是 O(1) 操作，不需要 backfill 脚本。

---

## § 2. 标签枚举（前端单一来源）

新建 `web/src/stageTags.ts`：

```ts
export const STAGE_TAGS = ['dev', 'review', 'test', 'release', 'blocked'] as const
export type StageTag = typeof STAGE_TAGS[number]

export const STAGE_TAG_META: Record<StageTag, { label: string; emoji: string; className: string }> = {
  dev:     { label: '待开发', emoji: '🔧', className: 'stage-tag-dev' },
  review:  { label: '待评审', emoji: '👀', className: 'stage-tag-review' },
  test:    { label: '待测试', emoji: '🧪', className: 'stage-tag-test' },
  release: { label: '待发布', emoji: '🚀', className: 'stage-tag-release' },
  blocked: { label: '阻塞中', emoji: '⛔', className: 'stage-tag-blocked' },
}
```

- 后端只做白名单校验，不复制这份元数据。
- `STAGE_TAGS` 数组同时充当下拉菜单的渲染顺序。

---

## § 3. 后端 API

### `PATCH /api/todos/:id`

- 复用现有 `updateTodo`，把 `stageTag` 加进白名单。
- 请求体：`{ stageTag: 'dev' | 'review' | 'test' | 'release' | 'blocked' | null }`
- 校验：值必须在白名单里，否则返回 400 `{ ok: false, error: 'invalid_stage_tag' }`；`null` 合法（清空标签）。
- 响应：返回更新后的 todo（已有逻辑）。

### `GET /api/todos`

- 返回的每条 todo 多带 `stageTag` 字段；`null` 时也显式返回（不省略），方便前端分支判断。

### `POST /api/todos`（创建）

- **不**支持创建时直接带 `stageTag`。新建表单不加这个字段以保持简洁，需要再做一次 PATCH。

### `PATCH /api/todos`（批量）

- `updateTodos` 白名单**不**加 `stageTag`（YAGNI——没人会一次给一堆 todo 同时改阶段）。

---

## § 4. 前端 UI

### 4.1 卡片上的 chip（TodoCard）

- 位置：现有 `todo-status-chip` 右边，紧挨着加一个 `stage-tag-chip`。
- 无标签：虚线轮廓的小 ➕ 占位 chip（"加阶段"），低调。
- 有标签：**tag 样式的彩色实底 pill**（不是只有 emoji + 文字），形如 Linear/Notion 标签。每个 className 对应一种调色（dev/review/test/release/blocked 各一种），具体配色实现时挑。
- 交互：点 chip 弹轻量浮层菜单（5 个标签 + "清除"），点选立即 PATCH，无需模态确认。
- 子 todo 卡片同样的 chip、同样的位置。

### 4.2 详情面板

- 在描述/截止时间那一区里加一行：`阶段标签：[当前 chip 或 ➕]`，点击行为同卡片。
- 卡片改了详情自动同步（共用同一份 todo state，store 已经在管，免费同步）。

### 4.3 新建 todo 弹窗

- 不加任何 stage_tag 字段。

### 4.4 浮层菜单组件（StageTagChip）

- 复用项目里现有的 Popover/下拉模式（参考 TopbarDispatch / SessionFocus 里最轻的那个），不引新依赖。
- 5 个选项 + 1 个"清除"，纯按钮列表，不做搜索/分组。

---

## § 5. 显式不做的事（边界）

- **不加筛选**：顶栏不动、quadrant 板不动。
- **不加批量改标签**。
- **不影响 AI session 状态机**：`stage_tag` 跟 `status`（todo / ai_running / ai_pending / ai_done / done）完全独立。AI 跑完不会自动改标签，标签也不触发 AI。
- **不导出 / 不同步**：
  - `src/export/todoMarkdown.js` 暂不输出 stage_tag。
  - Telegram / Lark 卡片暂不展示 stage_tag。
  - 将来需要是另一个 PR。
- **不写迁移脚本**：见 §1。
- **不动 stats / wiki / pipeline / recurring**。

---

## § 6. 测试范围

最小可信测试集：

- **db 单测**：`updateTodo` 接受合法 stageTag（5 个值 + null），拒绝非法值。
- **API 单测**：`PATCH /api/todos/:id` 白名单 + 错误码（`invalid_stage_tag`）。
- **前端**：手动验证（点卡片 chip 切换、详情面板同步），不写组件单测。

---

## § 7. 实现顺序（writing-plans 骨架）

1. db schema 加列 + `updateTodo` 白名单 + `listTodos` 返回 stageTag
2. `routes/todos.js` 校验 + 暴露字段
3. web 新建 `stageTags.ts` 字典
4. web 新建 `StageTagChip` 组件 + 浮层菜单
5. TodoCard 接入 chip
6. 详情面板接入同一组件
7. CSS 配色（5 种 tag 样式）
8. 跑一遍 + 手动验证
