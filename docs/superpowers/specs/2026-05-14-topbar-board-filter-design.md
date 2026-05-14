# Topbar Board Filter — Design

**日期**: 2026-05-14
**作者**: Claude + lzh
**状态**: Draft

## 背景与动机

`boardFilter`（待办 / 已完成 / 全部）目前在桌面端**只**通过 Cmd+K 命令面板的「视图」分组切换（`web/src/components/CommandPalette/CommandPalette.tsx:253-266`）。

- 移动端在 sticky header 已经有 `Radio.Group` 内联切换（`web/src/TodoManage.tsx:1079`）。
- 桌面端没有可见入口，新用户/不熟悉快捷键的用户找不到这个功能。

本次新增一个桌面端顶部栏的可见入口，让无需打开命令面板即可切换视图。

## 决策

| 维度 | 选择 | 备注 |
| --- | --- | --- |
| 形态 | **方案 A**：StatPill 风格 + Popover | 与现有 running/idle/pending pill 视觉语言一致 |
| 位置 | **A1**：紧贴 pending pill 右侧，spacer 之前 | 与"全局看板状态"语义同组 |
| value 显示 | **B1**：当前 filter 下的 todo 条数 | 顺带替代"看板有多少条"的认知负担 |
| Cmd+K 视图分组 | 保留不动 | 键盘用户继续可用 |
| 移动端 | 不动 | 现有 Radio.Group 已经够用 |
| 单测 | 不加 | 项目里前端组件没有 unit test 习惯，靠 dev server 手动验 |

## 用户故事

- **作为桌面端用户**，我想在顶部栏直接看到"我现在在看哪些 todo + 一共多少条"，并能一键切到"只看已完成"或"全部"，**不需要**记住 ⌘K 快捷键。
- **作为键盘用户**，⌘K 视图分组继续可用，行为不变。
- **作为移动端用户**，sticky header 的 Radio.Group 不动，体验不退化。

## UI 设计

### 形态

```
[🔻] [12] [只看待办 ▾]
```

- 图标：lucide `ListFilter`（与 `Filter` 相比更贴近"列表筛选"语义，且和 `Plus/Search/BarChart3/BookOpen/FileText/Settings` 同套）
- 图标颜色：`var(--accent-electric)`（用与 ⌘K 输入框 prefix 相同的强调色，跟 running/idle/pending 三种语义色区分开 —— 这是"操作/筛选"而不是"状态"）
- value：当前 `useTodoSnapshotStore.todos.length`
- label：根据 `boardFilter` 动态切换：
  - `'todo'` → `t('topbar:filter.labelTodo')` → "只看待办"
  - `'done'` → `t('topbar:filter.labelDone')` → "只看已完成"
  - `'all'`  → `t('topbar:filter.labelAll')`  → "全部"
- 后缀 `▾` 提示可下拉

### 交互

- 点击 pill → 打开 Popover（与 pending / running / idle pill 同一个 popover 风格，复用 `topbar-pending-popover` overlayClassName）
- Popover 内容：3 个 radio-style 行，参考 `CommandPalette.tsx:253-266`：
  ```
  ● 只看待办        ← 当前选中行高亮（背景 var(--accent-electric-soft) + 左边 dot var(--accent-electric)）
  ✓ 只看已完成
  ∗ 查看全部待办
  ```
- 点击某行 → 调 `useDispatchStore.getState().setBoardFilter(...)` → Popover 关闭
- Popover 不与其他 pill popover 互斥（保持现状）

### 位置

`TopbarDispatch.tsx` 的 children 顺序变成：

```
Logo
└─ running StatPill
└─ idle StatPill
└─ pending StatPill
└─ ▶ BoardFilterPill   ← 新增
└─ spacer
└─ ⌘K btn
└─ new / template / recover / stats / wiki / settings / theme
```

## 组件设计

### 新文件：`web/src/components/BoardFilterPill/BoardFilterPill.tsx`

- 不复用 `StatPill` 组件本身（StatPill 的 popover/选中态/click handler 模型与本组件不同），但**复用 `stat-pill` 这套 CSS class**（已在 `StatPill.css`），保证视觉对齐。
- 自己挂 `Popover open / onOpenChange`（与 TopbarDispatch 中 3 颗 pill 的 popover 写法一致）。
- 内部从 store 读：
  - `boardFilter` ← `useDispatchStore`
  - `setBoardFilter` ← `useDispatchStore`
  - `todos.length` ← `useTodoSnapshotStore`
- 无 props。

伪代码：

```tsx
export function BoardFilterPill() {
  const { t } = useTranslation('topbar')
  const [open, setOpen] = useState(false)
  const boardFilter = useDispatchStore((s) => s.boardFilter)
  const setBoardFilter = useDispatchStore((s) => s.setBoardFilter)
  const count = useTodoSnapshotStore((s) => s.todos.length)

  const labelKey =
    boardFilter === 'done' ? 'filter.labelDone'
    : boardFilter === 'all'  ? 'filter.labelAll'
    : 'filter.labelTodo'

  const options: Array<{ value: BoardFilter; icon: string; key: string }> = [
    { value: 'todo', icon: '●', key: 'filter.optionTodo' },
    { value: 'done', icon: '✓', key: 'filter.optionDone' },
    { value: 'all',  icon: '∗', key: 'filter.optionAll'  },
  ]

  const content = (
    <div className="topbar-filter-list">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`topbar-filter-row${boardFilter === opt.value ? ' is-active' : ''}`}
          onClick={() => { setBoardFilter(opt.value); setOpen(false) }}
        >
          <span className="topbar-filter-icon">{opt.icon}</span>
          <span>{t(opt.key)}</span>
        </button>
      ))}
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      overlayClassName="topbar-pending-popover"
      content={content}
    >
      <div className="stat-pill stat-pill-default stat-pill-clickable" onClick={() => setOpen(v => !v)}>
        <span className="stat-pill-custom-icon" style={{ color: 'var(--accent-electric)' }}>
          <ListFilter size={13} />
        </span>
        <span className="stat-pill-value">{count}</span>
        <span className="stat-pill-label">{t(labelKey)} ▾</span>
      </div>
    </Popover>
  )
}
```

### 改动：`web/src/components/BoardFilterPill/index.ts`

`export { BoardFilterPill } from './BoardFilterPill'`

### 改动：`web/src/components/TopbarDispatch/TopbarDispatch.tsx`

- 在 pending Popover (`</Popover>` 结束之后) 与 `<div className="topbar-spacer" />` 之间插入 `<BoardFilterPill />`。
- 不动现有 3 颗 StatPill 的任何逻辑。

### 改动：`web/src/components/TopbarDispatch/TopbarDispatch.css`

加 3 条 class：

```css
.topbar-filter-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 200px;
}
.topbar-filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--text-sm);
  cursor: pointer;
  text-align: left;
  transition: background var(--motion-fast) var(--ease-standard);
}
.topbar-filter-row:hover {
  background: var(--surface-2);
}
.topbar-filter-row.is-active {
  background: var(--accent-electric-soft);
  color: var(--accent-electric);
}
.topbar-filter-icon {
  width: 16px;
  display: inline-grid;
  place-items: center;
  font-family: var(--font-mono);
  color: var(--text-tertiary);
}
.topbar-filter-row.is-active .topbar-filter-icon {
  color: var(--accent-electric);
}
```

## 数据流

```
点击 pill row
  → useDispatchStore.setBoardFilter(next)
     → dispatchStore.boardFilter 更新
        → TodoManage useEffect 监听 filterStatus 变化 → fetchTodos()
           → setTodos(list) → useTodoSnapshotStore 同步
              → BoardFilterPill 的 count 重新渲染
              → TodoCard 列表重新渲染
```

`todos.length` 显示的是**当前 boardFilter 下已加载的条数**（fetch 是 server-side filter）。点击切换瞬间到 fetch 返回前，会有 ~100ms 显示上一次 filter 的旧 count，可接受（fetch 本地很快）。

## i18n

新增 key（已确认复用 `topbar` namespace，与同栏其它文案保持一组）：

**`web/src/i18n/locales/zh-CN.ts`** — `topbar:` 下新增：

```ts
filter: {
  labelTodo: '只看待办',
  labelDone: '只看已完成',
  labelAll: '全部',
  optionTodo: '只看待办',
  optionDone: '只看已完成',
  optionAll: '查看全部待办',
},
```

**`web/src/i18n/locales/en-US.ts`** — `topbar:` 下新增：

```ts
filter: {
  labelTodo: 'Active',
  labelDone: 'Completed',
  labelAll: 'All',
  optionTodo: 'Only active todos',
  optionDone: 'Only completed',
  optionAll: 'Show all todos',
},
```

> `label*` 是 pill 上显示（要短），`option*` 是 popover 选项（可长）。Cmd+K 视图分组的 `palette:actions.showOnlyTodo/showOnlyDone/showAll` 不动。

## 不做的事 (YAGNI)

- ❌ 不抽出更通用的 `<FilterPill>` 组件给其它地方用。当前只有这一个 filter，避免过度抽象。
- ❌ 不加键盘 ↑↓ 选项导航 —— Cmd+K 已经提供了键盘路径，pill 主要面向鼠标用户。
- ❌ 不持久化到 localStorage —— `boardFilter` 默认值是 `'todo'`，刷新后回到默认是合理的。如果未来要持久化，再做。
- ❌ 不显示"x 待办 / y 已完成 / z 全部"三个数字 —— 多了视觉噪音，单数即可。
- ❌ 不为这个组件加 unit / e2e test —— 项目惯例。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| `todos.length` 在 fetch 中途短暂显示旧值 | 接受。fetch 很快；视觉上 pill 不会"先变文字再变数字"，因为 `boardFilter` 更新是同步的，label 立即切换，仅 count 慢一帧 |
| pending pill popover 和 filter popover 都开着叠加 | 现有 3 pill 也不互斥，保持一致，AntD `Popover` 默认会让后开的覆盖前面，体验可接受 |
| 顶部栏挤——4 颗 pill + ⌘K + 6 个图标按钮 + theme，窄屏会换行 | 现状已经接近临界；若新 pill 加上去 1280px 还正常，则放过。如果 ≤1100px 出问题，单独再开一票处理（不属于本次范围） |

## 验收标准

- [ ] 桌面端顶部栏 pending pill 右侧出现新的 filter pill，显示当前数量 + 模式标签 + ▾。
- [ ] 点击 pill 弹出 Popover，列出 3 个选项；当前选中项有高亮（背景 + dot 色 = `--accent-electric`）。
- [ ] 点击任一选项 → 列表立刻按新 filter 刷新 → Popover 关闭 → pill label 与 count 更新。
- [ ] 明暗主题切换下，pill 的背景 / 边框 / 高亮色都跟随主题（不出现硬编码色）。
- [ ] Cmd+K 的「视图」分组继续可用，行为不变。
- [ ] 移动端 sticky header 的 Radio.Group 不变；新 pill 在移动端**天然不显示**（`TodoManage.tsx:1066` 用 `!isMobile` gate 了整个 `<TopbarDispatch />`，无需额外条件）。
- [ ] 顶部栏在 ≥1280px 宽度下不换行、不挤压 ⌘K 输入框。

## 开发步骤（先 spec、实现细节由 writing-plans 输出）

1. 新建 `web/src/components/BoardFilterPill/{BoardFilterPill.tsx,index.ts}`
2. 给 `TopbarDispatch.css` 追加 `.topbar-filter-*` 样式
3. 在 `TopbarDispatch.tsx` 引入并插入 pill
4. 给两份 i18n locale 加 `topbar:filter.*`
5. `pnpm dev`（或项目脚本）手动验：明暗主题、3 个选项切换、列表刷新、count 更新、Cmd+K 仍可用、移动端不影响
6. 提交 + push（按 `feedback_auto_push` 规则）
