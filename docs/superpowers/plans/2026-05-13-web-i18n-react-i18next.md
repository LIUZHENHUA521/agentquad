# Web 前端 i18n（react-i18next 全量迁移）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `web/` 前端全部用户可见的中文字面量迁移到 react-i18next，并把 CommandPalette 的英文文案改为中文。默认语言 zh-CN，预留 en-US 资源。

**Architecture:** i18next + react-i18next，TS 模块作为翻译资源（不是 JSON），通过 `declare module 'i18next'` 注入 key 类型校验。按 9 个 namespace（common / palette / topbar / todo / session / transcript / wiki / settings / errors）切分。迁移按 module 增量推进，每个 module 独立通过 `npm run build` + `npm test` 后 commit + push。

**Tech Stack:** TypeScript 5.6 / React 18.3 / Vite 5.4 / i18next 23.x / react-i18next 14.x / vitest（项目根 `npm test`）

**Spec reference:** `docs/superpowers/specs/2026-05-13-web-i18n-react-i18next-design.md`

---

## File Structure

迁移完成后的关键文件结构（新增 / 修改）：

```
web/src/
  i18n/                          [NEW]
    index.ts                     // i18next.init 副作用；导出 i18n 实例
    resources.ts                 // resources = { 'zh-CN': zh, 'en-US': en }
    types.d.ts                   // declare module 'i18next' CustomTypeOptions
    locales/
      zh-CN.ts                   // 中文资源（默认 / 兜底，结构化对象）
      en-US.ts                   // 英文资源（CommandPalette 已填，其余为 stub）
  main.tsx                       [MOD]  // 顶部 import './i18n'
  components/CommandPalette/
    CommandPalette.tsx           [MOD]  // useTranslation + t()
  components/TopbarDispatch/
    TopbarDispatch.tsx           [MOD]
  components/StatPill/
    StatPill.tsx                 [MOD]
  components/StageTagChip/
    StageTagChip.tsx             [MOD]
  components/ThemeToggle/
    ThemeToggle.tsx              [MOD]
  components/SessionFocus/
    SessionFocus.tsx             [MOD]
    FocusSubbar.tsx              [MOD]
  components/TodoCard/
    TodoCard.tsx                 [MOD]
  TodoManage.tsx                 [MOD]
  TranscriptView.tsx             [MOD]
  WikiDrawer.tsx                 [MOD]
  AiTerminalMini.tsx             [MOD]
  ... (其余约 30+ 个含中文字面量的文件)

web/package.json                 [MOD]  // 加 i18next + react-i18next
```

每个 module 改动后单独 commit。

---

### Task 1: 基础设施搭建（依赖 + i18n 骨架 + 主入口）

**Files:**
- Modify: `web/package.json`（加依赖）
- Create: `web/src/i18n/index.ts`
- Create: `web/src/i18n/resources.ts`
- Create: `web/src/i18n/types.d.ts`
- Create: `web/src/i18n/locales/zh-CN.ts`
- Create: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/main.tsx:1-25`（顶部 import `./i18n`）

- [ ] **Step 1.1: 安装依赖**

Run:
```bash
cd web && npm install i18next@^23 react-i18next@^14
```
Expected: package.json 中 dependencies 多出 `i18next` 与 `react-i18next`，package-lock.json 更新；无 peerDep 警告。

- [ ] **Step 1.2: 创建 zh-CN 资源骨架**

Create `web/src/i18n/locales/zh-CN.ts`：

```ts
const zh = {
  common: {
    confirm: '确定',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    restore: '恢复',
    close: '关闭',
    edit: '编辑',
    copy: '复制',
    refresh: '刷新',
    loading: '加载中…',
    empty: '暂无数据',
    todo: '待办',
    done: '已完成',
    running: '运行中',
    idle: '空闲',
    yes: '是',
    no: '否',
  },
  palette: {},
  topbar: {},
  todo: {},
  session: {},
  transcript: {},
  wiki: {},
  settings: {},
  errors: {},
} as const

export default zh
export type Resources = typeof zh
```

- [ ] **Step 1.3: 创建 en-US 资源骨架（结构镜像 zh）**

Create `web/src/i18n/locales/en-US.ts`：

```ts
import type { Resources } from './zh-CN'

const en: Resources = {
  common: {
    confirm: 'OK',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    restore: 'Restore',
    close: 'Close',
    edit: 'Edit',
    copy: 'Copy',
    refresh: 'Refresh',
    loading: 'Loading…',
    empty: 'No data',
    todo: 'Todo',
    done: 'Done',
    running: 'Running',
    idle: 'Idle',
    yes: 'Yes',
    no: 'No',
  },
  palette: {},
  todo: {},
  topbar: {},
  session: {},
  transcript: {},
  wiki: {},
  settings: {},
  errors: {},
}

export default en
```

> **注意**：TS 会报"`palette` 类型不匹配"（zh 中 palette 是 `{}`，en 中也是 `{}`，目前 OK；后续 task 往 zh 加 key 时会让 en 的 stub 必须同步增长 — 这正是类型安全的价值）。如果出现编译报错，往 en 对应 namespace 补 stub（值可以暂时复用中文，确保结构一致）。

- [ ] **Step 1.4: 创建 resources 聚合**

Create `web/src/i18n/resources.ts`：

```ts
import zh from './locales/zh-CN'
import en from './locales/en-US'

export const resources = {
  'zh-CN': zh,
  'en-US': en,
} as const

export type SupportedLng = keyof typeof resources
```

- [ ] **Step 1.5: 创建 i18next 初始化**

Create `web/src/i18n/index.ts`：

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from './locales/zh-CN'
import en from './locales/en-US'

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': zh,
      'en-US': en,
    },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common', 'palette', 'topbar', 'todo', 'session', 'transcript', 'wiki', 'settings', 'errors'],
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  })

export default i18n
```

- [ ] **Step 1.6: 创建类型注入**

Create `web/src/i18n/types.d.ts`：

```ts
import 'i18next'
import type zh from './locales/zh-CN'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof zh
  }
}
```

- [ ] **Step 1.7: 在 main.tsx 注入**

Modify `web/src/main.tsx`，在 line 6（dayjs locale import 之后、tokens.css import 之前）插入：

```ts
import './i18n'
```

最终 main.tsx 顶部块大致为：
```ts
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import './i18n'                           // ← 新增
import './design/tokens.css'
// ...其余不变
```

- [ ] **Step 1.8: 构建校验**

Run:
```bash
cd web && npm run build
```
Expected: PASS（无 TS 错、无 vite 错）。dist 产物中能搜到 `i18next` 痕迹（侧面证明 bundle 成功）。

- [ ] **Step 1.9: 浏览器烟测**

启动 dev 服务，确认 UI 与迁移前完全一致（因为所有组件还没改）。Run:
```bash
cd web && npm run dev
```
打开浏览器访问 http://localhost:5173 或对应端口；确认看板能渲染、能开 CommandPalette、能切换主题。

- [ ] **Step 1.10: Commit + Push**

```bash
git add web/package.json web/package-lock.json web/src/i18n web/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(web/i18n): 接入 react-i18next 基础设施

- 装 i18next@^23 + react-i18next@^14
- 新建 web/src/i18n/{index,resources,types.d}.ts
- 新建 zh-CN / en-US 资源骨架（common namespace 已填，其余 namespace 为空对象）
- main.tsx 顶部 import './i18n' 触发初始化
- 默认语言 zh-CN，fallback zh-CN，defaultNS common

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

### Task 2: CommandPalette 全量迁移（用户原始诉求）

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（往 palette namespace 填充）
- Modify: `web/src/i18n/locales/en-US.ts`（同步 stub 结构）
- Modify: `web/src/components/CommandPalette/CommandPalette.tsx`

- [ ] **Step 2.1: 往 zh-CN 的 palette namespace 填完整 key**

修改 `web/src/i18n/locales/zh-CN.ts`，把 `palette: {}` 替换为：

```ts
palette: {
  a11y: {
    commandPalette: '命令面板',
  },
  placeholder: '输入命令或搜索待办…',
  placeholderAi: '搜索一个待办来启动 AI 会话（{{tool}}）…',
  empty: {
    noResults: '无匹配结果。',
    noTodos: '没有可用的待办 — 请先创建一个。',
  },
  groups: {
    quickActions: '快捷操作',
    jumpToTodo: '跳转待办',
    focusSession: '专注会话',
    drawers: '功能面板',
    view: '视图',
    system: '系统',
    recentTodos: '最近 / 活跃的待办',
  },
  actions: {
    createTodo: '新建待办',
    startAi: '启动 AI 会话（{{tool}}） →',
    pickTodoForAi: '启动 AI 会话 — 选择一个待办（{{tool}}）',
    backToDefault: '返回',
    focusLabel: '专注：{{title}}',
    restoreToTodo: '恢复到待办：{{label}}',
    openStatsReports: '打开统计与报告',
    openWiki: '打开知识库',
    openSettings: '打开设置',
    openStats: '打开统计',
    insertFromTemplate: '从模板插入…',
    telegramSync: 'Telegram 同步',
    showOnlyTodo: '只看待办',
    showOnlyDone: '只看已完成',
    showAll: '查看全部待办',
    toggleTheme: '切换主题（深色 / 浅色）',
  },
  meta: {
    done: '已完成',
  },
  subtaskLabel: '↳ {{parent}} / {{title}}',
},
```

- [ ] **Step 2.2: 同步 en-US 的 palette namespace（保持类型同步）**

修改 `web/src/i18n/locales/en-US.ts`，把 `palette: {}` 替换为：

```ts
palette: {
  a11y: {
    commandPalette: 'Command Palette',
  },
  placeholder: 'Type a command or search a todo...',
  placeholderAi: 'Search a todo to start AI session ({{tool}})...',
  empty: {
    noResults: 'No results.',
    noTodos: 'No todos available — create one first.',
  },
  groups: {
    quickActions: 'Quick actions',
    jumpToTodo: 'Jump to todo',
    focusSession: 'Focus session',
    drawers: 'Drawers',
    view: 'View',
    system: 'System',
    recentTodos: 'Recent / Active todos',
  },
  actions: {
    createTodo: 'Create new todo',
    startAi: 'Start AI session ({{tool}}) →',
    pickTodoForAi: 'Start AI session — pick a todo ({{tool}})',
    backToDefault: 'Back',
    focusLabel: 'Focus: {{title}}',
    restoreToTodo: 'Restore to todo: {{label}}',
    openStatsReports: 'Open Stats & Reports',
    openWiki: 'Open Wiki',
    openSettings: 'Open Settings',
    openStats: 'Open Stats',
    insertFromTemplate: 'Insert from Template…',
    telegramSync: 'Telegram sync',
    showOnlyTodo: 'Show only todo',
    showOnlyDone: 'Show only done',
    showAll: 'Show all todos',
    toggleTheme: 'Toggle theme (dark / light)',
  },
  meta: {
    done: 'Done',
  },
  subtaskLabel: '↳ {{parent}} / {{title}}',
},
```

- [ ] **Step 2.3: 同步 errors namespace（CommandPalette 用到的 restoredAs / restoreFailed）**

修改 `web/src/i18n/locales/zh-CN.ts` 中 `errors: {}` 与 `todo: {}`：

```ts
todo: {
  restoredToTodo: '已恢复为待办',
},
errors: {
  restoreFailed: '恢复失败',
},
```

同步 en-US：
```ts
todo: {
  restoredToTodo: 'Restored to todo',
},
errors: {
  restoreFailed: 'Restore failed',
},
```

- [ ] **Step 2.4: 类型校验中间检查**

Run:
```bash
cd web && npx tsc --noEmit
```
Expected: PASS（zh / en 结构对齐，types.d.ts 中 `Resources` 类型解析正确）。
若失败：通常是 en 缺 key — 按错误提示补 stub。

- [ ] **Step 2.5: 改造 CommandPalette.tsx（用 t() 替换全部英文 / 中文字面量）**

完整替换 `web/src/components/CommandPalette/CommandPalette.tsx`：

```tsx
import { useState, useEffect, useMemo } from 'react'
import { Command } from 'cmdk'
import { useTranslation } from 'react-i18next'
import { useDispatchStore } from '../../store/dispatchStore'
import { useTheme } from '../../design/ThemeProvider'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { listTodos, updateTodo, type Todo } from '../../api'
import { useAppMessages } from '../../design/useAppMessages'
import { BarChart3, BookOpen, Settings, BarChartBig, FileText, Send, Moon } from 'lucide-react'
import './CommandPalette.css'

type Page = 'default' | 'aiPicker'

interface TodoEntry {
  id: string
  sessionId: string
  title: string
  status?: string
  tool?: string
  quad?: number | string
}

const JUMP_LIST_EMPTY_LIMIT = 20

export function CommandPalette() {
  const { t } = useTranslation()
  const open = useDispatchStore((s) => s.palette)
  const closePalette = useDispatchStore((s) => s.closePalette)
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const { toggle: toggleTheme } = useTheme()
  const { message } = useAppMessages()

  const [page, setPage] = useState<Page>('default')
  const [aiTool, setAiTool] = useState<'claude' | 'codex' | 'cursor'>('claude')
  const [search, setSearch] = useState('')
  const [allTodos, setAllTodos] = useState<Todo[]>([])

  useEffect(() => {
    if (open) {
      setPage('default')
      setSearch('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listTodos({}).then((list) => {
      if (!cancelled) setAllTodos(list)
    }).catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [open])

  const sessions = useAiSessionStore((s) => s.sessions)

  const parentTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of allTodos) if (!t.parentId) map.set(t.id, t.title)
    return map
  }, [allTodos])

  const jumpListTodos = useMemo(() => {
    if (search.trim()) return allTodos
    return [...allTodos]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, JUMP_LIST_EMPTY_LIMIT)
  }, [allTodos, search])

  function jumpToTodo(todo: Todo) {
    if (todo.status === 'done') {
      useDispatchStore.getState().setBoardFilter('all')
    }
    useDispatchStore.getState().setJumpTo(todo.id)
    closePalette()
  }

  async function restoreTodo(todo: Todo) {
    closePalette()
    try {
      await updateTodo(todo.id, { status: 'todo' })
      useDispatchStore.getState().setBoardFilter('todo')
      useDispatchStore.getState().signal('refreshTodos')
      useDispatchStore.getState().setJumpTo(todo.id)
      message.success(t('todo.restoredToTodo'))
    } catch (e: any) {
      message.error(e?.message || t('errors.restoreFailed'))
    }
  }

  const seenTodoIds = new Set<string>()
  const todos: TodoEntry[] = []
  sessions.forEach((s) => {
    const id = s.todoId ?? s.sessionId
    if (!id || seenTodoIds.has(id)) return
    seenTodoIds.add(id)
    todos.push({
      id,
      sessionId: s.sessionId,
      title: s.todoTitle,
      status: s.status,
      tool: s.tool,
      quad: s.quadrant,
    })
  })

  if (!open) return null

  return (
    <div
      className="cmdk-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette()
      }}
    >
      <Command
        label={t('palette.a11y.commandPalette')}
        className="cmdk-root"
        shouldFilter={page === 'default'}
      >
        <div className="cmdk-input-wrap">
          <span className="cmdk-prefix">⌘</span>
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder={
              page === 'aiPicker'
                ? t('palette.placeholderAi', { tool: aiTool })
                : t('palette.placeholder')
            }
            autoFocus
          />
          <kbd>esc</kbd>
        </div>

        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">{t('palette.empty.noResults')}</Command.Empty>

          {page === 'default' && (
            <>
              <Command.Group heading={t('palette.groups.quickActions')}>
                <Command.Item onSelect={() => {
                  useDispatchStore.getState().signal('newTodo')
                  closePalette()
                }}>
                  <span className="cmdk-icon">+</span>
                  <span>{t('palette.actions.createTodo')}</span>
                  <span className="cmdk-meta">N</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('claude'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>{t('palette.actions.startAi', { tool: 'claude' })}</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('codex'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>{t('palette.actions.startAi', { tool: 'codex' })}</span>
                </Command.Item>
                <Command.Item
                  onSelect={() => { setAiTool('cursor'); setPage('aiPicker'); setSearch('') }}
                >
                  <span className="cmdk-icon">▶</span>
                  <span>{t('palette.actions.startAi', { tool: 'cursor' })}</span>
                </Command.Item>
              </Command.Group>

              {jumpListTodos.length > 0 && (
                <Command.Group heading={t('palette.groups.jumpToTodo')}>
                  {jumpListTodos.flatMap((todo) => {
                    const isDone = todo.status === 'done'
                    const parentTitle = todo.parentId ? parentTitleById.get(todo.parentId) : null
                    const label = parentTitle
                      ? t('palette.subtaskLabel', { parent: parentTitle, title: todo.title })
                      : todo.title
                    const jumpItem = (
                      <Command.Item
                        key={`todo-${todo.id}`}
                        value={`todo-${todo.id}-${label}`}
                        onSelect={() => jumpToTodo(todo)}
                      >
                        <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>
                          {isDone ? '↗' : '›'}
                        </span>
                        <span>{label}</span>
                        {isDone && <span className="cmdk-meta">{t('palette.meta.done')}</span>}
                      </Command.Item>
                    )
                    if (!isDone) return [jumpItem]
                    return [
                      jumpItem,
                      <Command.Item
                        key={`restore-${todo.id}`}
                        value={`restore-${todo.id}-${label}`}
                        onSelect={() => restoreTodo(todo)}
                      >
                        <span className="cmdk-icon">↺</span>
                        <span>{t('palette.actions.restoreToTodo', { label })}</span>
                      </Command.Item>,
                    ]
                  })}
                </Command.Group>
              )}

              {todos.length > 0 && (
                <Command.Group heading={t('palette.groups.focusSession')}>
                  {todos.map((todo) => (
                    <Command.Item
                      key={`focus-${todo.id}`}
                      value={`focus-${todo.id}-${todo.title}`}
                      onSelect={() => {
                        useDispatchStore.getState().openFocus(todo.id, todo.sessionId)
                        closePalette()
                      }}
                    >
                      <span className="cmdk-icon">⇆</span>
                      <span>{t('palette.actions.focusLabel', { title: todo.title })}</span>
                      {todo.tool && <span className="cmdk-meta">{todo.tool}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading={t('palette.groups.drawers')}>
                <Command.Item onSelect={() => { openDrawer('report'); closePalette() }}>
                  <span className="cmdk-icon"><BarChart3 size={14} /></span>
                  <span>{t('palette.actions.openStatsReports')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('wiki'); closePalette() }}>
                  <span className="cmdk-icon"><BookOpen size={14} /></span>
                  <span>{t('palette.actions.openWiki')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('settings'); closePalette() }}>
                  <span className="cmdk-icon"><Settings size={14} /></span>
                  <span>{t('palette.actions.openSettings')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('statsReports'); closePalette() }}>
                  <span className="cmdk-icon"><BarChartBig size={14} /></span>
                  <span>{t('palette.actions.openStats')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { openDrawer('template'); closePalette() }}>
                  <span className="cmdk-icon"><FileText size={14} /></span>
                  <span>{t('palette.actions.insertFromTemplate')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().signal('telegramSync'); closePalette() }}>
                  <span className="cmdk-icon"><Send size={14} /></span>
                  <span>{t('palette.actions.telegramSync')}</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading={t('palette.groups.view')}>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('todo'); closePalette() }}>
                  <span className="cmdk-icon">●</span>
                  <span>{t('palette.actions.showOnlyTodo')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('done'); closePalette() }}>
                  <span className="cmdk-icon">✓</span>
                  <span>{t('palette.actions.showOnlyDone')}</span>
                </Command.Item>
                <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('all'); closePalette() }}>
                  <span className="cmdk-icon">∗</span>
                  <span>{t('palette.actions.showAll')}</span>
                </Command.Item>
              </Command.Group>

              <Command.Group heading={t('palette.groups.system')}>
                <Command.Item onSelect={() => { toggleTheme(); closePalette() }}>
                  <span className="cmdk-icon"><Moon size={14} /></span>
                  <span>{t('palette.actions.toggleTheme')}</span>
                </Command.Item>
              </Command.Group>
            </>
          )}

          {page === 'aiPicker' && (() => {
            const pickable = jumpListTodos.filter((todo) => todo.status !== 'done')
            return (
              <>
                <div className="cmdk-back-row" onClick={() => setPage('default')}>
                  <span style={{ color: 'var(--accent-electric)' }}>←</span>
                  <span>{t('palette.actions.pickTodoForAi', { tool: aiTool })}</span>
                </div>
                {pickable.length === 0 && (
                  <div className="cmdk-empty">{t('palette.empty.noTodos')}</div>
                )}
                {pickable.length > 0 && (
                  <Command.Group heading={t('palette.groups.recentTodos')}>
                    {pickable.map((todo) => {
                      const parentTitle = todo.parentId ? parentTitleById.get(todo.parentId) : null
                      const label = parentTitle
                        ? t('palette.subtaskLabel', { parent: parentTitle, title: todo.title })
                        : todo.title
                      const liveStatus = todos.find((x) => x.id === todo.id)?.status
                      return (
                        <Command.Item
                          key={todo.id}
                          value={`picktodo-${todo.id}-${label}`}
                          onSelect={() => {
                            useDispatchStore.getState().startAiSession(todo.id, aiTool)
                            closePalette()
                          }}
                        >
                          <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>›</span>
                          <span>{label}</span>
                          {liveStatus && <span className="cmdk-meta">{liveStatus}</span>}
                        </Command.Item>
                      )
                    })}
                  </Command.Group>
                )}
              </>
            )
          })()}
        </Command.List>
      </Command>
    </div>
  )
}
```

> **关键差异点**：
> - `const t` 的局部变量重命名为 `todo` 以避免与 `useTranslation` 的 `t` 函数冲突（原代码用 `t` 作 todo 项变量，会被遮蔽）。
> - aiPicker `liveStatus` 直接显示原始字符串（如 `'todo'`/`'done'`），暂不 i18n —— 这是技术状态枚举，非用户输入文案。

- [ ] **Step 2.6: 构建 + 类型校验**

Run:
```bash
cd web && npm run build
```
Expected: PASS。

- [ ] **Step 2.7: 浏览器手测**

启动 dev 服务，按 `Cmd+K` 打开 CommandPalette。验证清单：

- 占位符显示"输入命令或搜索待办…"
- group 标题："快捷操作"、"跳转待办"、"功能面板"、"视图"、"系统"
- 菜单项："新建待办"、"启动 AI 会话（claude） →" 等
- 切到 aiPicker（点 Start AI session claude）显示"启动 AI 会话 — 选择一个待办（claude）"
- 中文搜索测试：输入"待办"，能命中"跳转待办"组的项目；输入"启动"，能命中"启动 AI 会话"菜单项
- esc 键关闭面板、N 快捷键提示仍是英文 N

- [ ] **Step 2.8: Commit + Push**

```bash
git add web/src/i18n/locales web/src/components/CommandPalette/CommandPalette.tsx
git commit -m "$(cat <<'EOF'
feat(web/i18n): CommandPalette 全量迁移到 i18n（中文 + 英文 stub）

- palette namespace 完整填充 zh-CN + en-US（约 25 处文案）
- t() 替换所有用户可见字符串，含 a11y label、placeholder、group heading、菜单项、empty state
- 复用 todo.restoredToTodo / errors.restoreFailed
- 按键 hint（esc、N）保留英文（国际通用键盘符号）
- 局部变量 t 改名为 todo 避免与 useTranslation 的 t 冲突

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

### Task 3: common + topbar + errors（高频被引用的基础文案）

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（继续填 namespace）
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/components/TopbarDispatch/TopbarDispatch.tsx`
- Modify: `web/src/components/StatPill/StatPill.tsx`
- Modify: `web/src/components/StageTagChip/StageTagChip.tsx`
- Modify: `web/src/components/ThemeToggle/ThemeToggle.tsx`

- [ ] **Step 3.1: 发现阶段 — 列出每个文件的中文字面量**

Run:
```bash
cd web/src && grep -nP "['\"\`][\x{4e00}-\x{9fff}]" \
  components/TopbarDispatch/TopbarDispatch.tsx \
  components/StatPill/StatPill.tsx \
  components/StageTagChip/StageTagChip.tsx \
  components/ThemeToggle/ThemeToggle.tsx
```

把每行字面量整理成草稿表（人工 review）：
| 文件 | 行号 | 中文 | 建议 key |
|---|---|---|---|

> **关键约定**：
> - 通用动作（"刷新"、"重试"）放 `common.*`
> - topbar 专属（如统计栏的 label）放 `topbar.*`
> - 错误 message.error 调用的字符串放 `errors.*`
> - 含变量的字符串改成插值（`{{count}}`、`{{name}}`）

- [ ] **Step 3.2: 写入资源文件**

把整理好的 key 加到 `zh-CN.ts` 的 `topbar` / `common` / `errors` 中；同步 `en-US.ts` 的 stub（英文翻译，至少不能让 TS 报错）。

示例片段（实际内容以 grep 结果为准）：
```ts
topbar: {
  stats: {
    unread: '未读 {{count}}',
    running: '运行中 {{count}}',
    idle: '空闲 {{count}}',
  },
  theme: {
    toggle: '切换主题',
    dark: '深色模式',
    light: '浅色模式',
  },
  stage: {
    backlog: '待规划',
    planning: '规划中',
    inProgress: '进行中',
    review: '审核中',
    done: '已完成',
    blocked: '阻塞',
  },
},
```

- [ ] **Step 3.3: 改造组件**

每个组件顶部加 `import { useTranslation } from 'react-i18next'` 与 `const { t } = useTranslation()`，把字面量替换为 `t('xxx')`。

> **共同模式**：
> ```tsx
> // before
> <Tooltip title="刷新">
> // after
> <Tooltip title={t('common.refresh')}>
>
> // before
> message.success('已保存')
> // after
> message.success(t('common.saveSuccess'))
> ```

- [ ] **Step 3.4: 构建 + 类型校验**

Run: `cd web && npm run build`
Expected: PASS。

- [ ] **Step 3.5: 单元测试**

Run: `cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npm test`
Expected: PASS（前端断言中文输出，渲染语言仍是 zh-CN，应不影响）。如有失败，逐个修正断言或资源。

- [ ] **Step 3.6: 浏览器手测**

打开 dev 服务，确认顶栏 stats pill、主题切换、阶段标签的显示与之前一致。

- [ ] **Step 3.7: Commit + Push**

```bash
git add web/src/i18n/locales web/src/components/TopbarDispatch web/src/components/StatPill web/src/components/StageTagChip web/src/components/ThemeToggle
git commit -m "$(cat <<'EOF'
feat(web/i18n): 迁移 topbar / common / errors 基础文案

- 顶栏统计栏、主题切换、阶段标签均通过 t() 访问
- common namespace 补齐高频复用文案（refresh、saveSuccess 等）
- errors namespace 收口 message.error 的硬编码

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

### Task 4: TodoManage / TodoCard / 四象限

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（填 todo namespace）
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/TodoManage.tsx`
- Modify: `web/src/components/TodoCard/TodoCard.tsx`

> **注意**：TodoManage 是项目最大单文件（数千行），中文字面量预计 100+ 处。本 task 工作量大，必要时再拆 4a/4b/4c 子 commit。

- [ ] **Step 4.1: 发现阶段**

Run:
```bash
cd web/src && grep -cP "['\"\`][\x{4e00}-\x{9fff}]" TodoManage.tsx components/TodoCard/TodoCard.tsx
```
预计 100+ 行命中。把所有字面量分组：
- 看板筛选 / 排序 / 视图切换 → `todo.board.*`
- 四象限标题 / 描述 → `todo.quadrant.*`（q1/q2/q3/q4 + label/hint）
- TodoCard 上的标签、操作按钮 → `todo.card.*`
- 弹窗（新建 / 编辑 / 删除确认）→ `todo.modal.*`
- 消息提示 → `errors.*` 或 `todo.message.*`

- [ ] **Step 4.2: 资源写入（分批，每批 30-40 个 key）**

每写完一批就 `npm run build` 校验类型。整体写完后 zh-CN.ts 的 todo namespace 预计 ~150 个 key。

示例结构：
```ts
todo: {
  restoredToTodo: '已恢复为待办',
  board: {
    filterAll: '全部',
    filterTodo: '待办',
    filterDone: '已完成',
    sortByUpdate: '按更新时间',
    sortByCreate: '按创建时间',
    emptyHint: '暂无待办，按 N 新建',
  },
  quadrant: {
    q1: { label: '重要且紧急', hint: '马上做' },
    q2: { label: '重要不紧急', hint: '计划做' },
    q3: { label: '紧急不重要', hint: '委托他人' },
    q4: { label: '不重要不紧急', hint: '少做或不做' },
  },
  card: {
    edit: '编辑',
    delete: '删除',
    markDone: '完成',
    reopen: '重开',
    archive: '归档',
    addSubtask: '添加子任务',
    openSession: '打开会话',
  },
  modal: {
    createTitle: '新建待办',
    editTitle: '编辑待办',
    deleteConfirm: '确定删除「{{title}}」吗？',
    deleteCancel: '取消',
    deleteOk: '删除',
  },
  message: {
    created: '已创建',
    updated: '已更新',
    deleted: '已删除',
  },
},
```

- [ ] **Step 4.3: 改造 TodoManage.tsx**

加 `useTranslation`，逐处替换。注意：
- 模板字符串如 ``${count} 条已完成`` → `t('todo.board.doneCount', { count })`
- 三元运算中的字符串如 `status === 'done' ? '已完成' : '待办'` → `t(status === 'done' ? 'common.done' : 'common.todo')`
- `Modal.confirm({ title: '...' })` → `Modal.confirm({ title: t('todo.modal.deleteTitle') })`

- [ ] **Step 4.4: 改造 TodoCard.tsx**

同上模式。

- [ ] **Step 4.5: 构建 + 测试**

Run:
```bash
cd web && npm run build
cd .. && npm test -- todo
```
Expected: PASS。

- [ ] **Step 4.6: 浏览器手测核心交互**

- 看板渲染：四象限标题、TodoCard 文案均为中文
- 新建/编辑/删除 todo
- 拖拽换象限
- 完成/重开切换
- 筛选 todo/done/all

- [ ] **Step 4.7: Commit + Push**

```bash
git add web/src/i18n/locales web/src/TodoManage.tsx web/src/components/TodoCard
git commit -m "$(cat <<'EOF'
feat(web/i18n): 迁移 TodoManage 与 TodoCard

- todo namespace 填充看板筛选 / 四象限 / 卡片操作 / 弹窗文案（约 150 keys）
- TodoManage.tsx 全部中文字面量走 t()
- TodoCard.tsx 操作按钮 / 标签 i18n 化

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

### Task 5: SessionFocus / FocusSubbar / AiTerminalMini

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（填 session namespace）
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/components/SessionFocus/SessionFocus.tsx`
- Modify: `web/src/components/SessionFocus/FocusSubbar.tsx`
- Modify: `web/src/AiTerminalMini.tsx`

- [ ] **Step 5.1: 发现 + 资源写入**

Run:
```bash
cd web/src && grep -cP "['\"\`][\x{4e00}-\x{9fff}]" \
  components/SessionFocus/SessionFocus.tsx \
  components/SessionFocus/FocusSubbar.tsx \
  AiTerminalMini.tsx
```
按发现的字面量填充 zh-CN.ts 的 `session` namespace。

示例：
```ts
session: {
  title: '专注会话',
  start: '启动会话',
  stop: '停止',
  restart: '重启',
  copy: '复制',
  send: '发送',
  awaitingReply: '等待回复…',
  thinking: '思考中…',
  toolRunning: '执行工具：{{tool}}',
  closeConfirm: '确定关闭会话？',
  emptyHint: '暂无会话，新建一个待办开始',
  tool: {
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
  },
  status: {
    idle: '空闲',
    running: '运行中',
    waiting: '等待用户',
    done: '已完成',
    error: '出错',
  },
},
```

同步 en-US。

- [ ] **Step 5.2: 改造组件**

每个文件加 useTranslation + t() 替换。

- [ ] **Step 5.3: 构建 + 测试**

Run:
```bash
cd web && npm run build
cd .. && npm test -- "ai-session|ai-terminal"
```

- [ ] **Step 5.4: 浏览器手测**

- 开 SessionFocus（双击 TodoCard 或 cmdk Focus 项）
- 启动 / 停止 AI 会话
- 状态显示（等待回复 / 运行中 / 思考中）

- [ ] **Step 5.5: Commit + Push**

```bash
git add web/src/i18n/locales web/src/components/SessionFocus web/src/AiTerminalMini.tsx
git commit -m "$(cat <<'EOF'
feat(web/i18n): 迁移 SessionFocus / FocusSubbar / AiTerminalMini

- session namespace 含状态、工具按钮、AI 工具名等文案
- SessionFocus 启动/停止/重启按钮 i18n 化
- AiTerminalMini 状态指示 i18n 化

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

### Task 6: TranscriptView 及子组件

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（填 transcript namespace）
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/TranscriptView.tsx`
- Modify: 任何 TranscriptView 引入的子组件（如 message bubble、diff viewer wrapper）

- [ ] **Step 6.1: 发现 + 资源**

```bash
cd web/src && grep -nP "['\"\`][\x{4e00}-\x{9fff}]" TranscriptView.tsx
```

示例 keys：
```ts
transcript: {
  empty: '暂无对话记录',
  copyAll: '复制全部',
  copyOne: '复制此条',
  copied: '已复制',
  jumpToBottom: '跳转到底部',
  loadMore: '加载更多',
  toolCall: '工具调用：{{name}}',
  toolResult: '工具结果',
  thinking: '思考中…',
},
```

- [ ] **Step 6.2: 改造 + 构建 + 测试**

Run:
```bash
cd web && npm run build
cd .. && npm test -- transcript
```

- [ ] **Step 6.3: 浏览器手测**

- 打开一个有对话历史的 todo
- 复制 / 跳底部 / 加载更多 交互

- [ ] **Step 6.4: Commit + Push**

```bash
git add web/src/i18n/locales web/src/TranscriptView.tsx
git commit -m "feat(web/i18n): 迁移 TranscriptView

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

### Task 7: WikiDrawer / Settings / 其他抽屉

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`（填 wiki / settings namespace）
- Modify: `web/src/i18n/locales/en-US.ts`
- Modify: `web/src/WikiDrawer.tsx`
- Modify: 其他抽屉组件（Settings、TelegramProbeModal、StatsReports 等）

- [ ] **Step 7.1: 发现各抽屉的中文字面量**

```bash
cd web/src && for f in WikiDrawer.tsx TelegramProbeModal.tsx; do
  echo "=== $f ==="
  grep -nP "['\"\`][\x{4e00}-\x{9fff}]" "$f" | head -30
done
```
（注意：实际抽屉文件名可能不同，按 `ls web/src/*.tsx` 与 `ls web/src/components/**/*.tsx` 实际为准）

- [ ] **Step 7.2: 资源写入 + 组件改造**

```ts
wiki: {
  title: '知识库',
  projects: '项目',
  sources: '来源文档',
  search: '搜索',
  empty: '尚未生成知识库',
},
settings: {
  title: '设置',
  theme: '主题',
  language: '语言',
  telegram: 'Telegram',
  ai: 'AI 配置',
},
```

- [ ] **Step 7.3: 构建 + 测试 + 手测**

```bash
cd web && npm run build
cd .. && npm test
```

- [ ] **Step 7.4: Commit + Push**

```bash
git add web/src/i18n/locales web/src/WikiDrawer.tsx web/src/*.tsx
git commit -m "feat(web/i18n): 迁移 wiki / settings / 其他抽屉

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

### Task 8: 剩余零散组件

**Files:**
- Modify: `web/src/i18n/locales/zh-CN.ts`、`web/src/i18n/locales/en-US.ts`
- Modify: 剩余所有含中文字面量的 `.tsx` / `.ts` 文件（约 20+ 个零散文件）

- [ ] **Step 8.1: 发现剩余文件**

```bash
cd web/src && grep -rlP "['\"\`][\x{4e00}-\x{9fff}]" \
  --include="*.tsx" --include="*.ts" \
  --exclude-dir=i18n \
  | xargs -I{} grep -c "useTranslation" {} \
  > /tmp/i18n-files.txt
```

逐文件 review：还没有 useTranslation 引入的文件就是剩余目标。

- [ ] **Step 8.2: 逐文件迁移（小批量）**

每 3-5 个文件一组 commit，避免单 commit 改动过大。

- [ ] **Step 8.3: 构建 + 测试**

```bash
cd web && npm run build
cd .. && npm test
```

- [ ] **Step 8.4: Commit + Push**

```bash
git add web/src/i18n/locales web/src/...（具体文件）
git commit -m "feat(web/i18n): 迁移剩余零散组件

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

### Task 9: 测试用例修正

**Files:**
- Modify: `test/**/*.test.ts` / `test/**/*.test.js`（仅必要时）

- [ ] **Step 9.1: 全量跑测试**

Run: `cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npm test`

记录失败用例。

- [ ] **Step 9.2: 分类处理**

- **类别 A**：断言 UI 渲染中文文案 → 不动（迁移后渲染仍是中文）
- **类别 B**：断言某个 raw 字符串值（如 `expect(x).toBe('已完成')`），但代码里已改成 `t('common.done')` → 重新对一遍：如果 `t('common.done')` 返回值就是 `'已完成'`，断言不变；如果 key 翻译有调整，更新断言
- **类别 C**：mock i18n 缺失 → 在 setup 文件中初始化 i18n（可能需要 vitest setup 文件）

- [ ] **Step 9.3: 必要时新增 vitest setup**

如果发现 jsdom 环境下 `useTranslation` 没初始化，新建或修改 `vitest.config.ts` / `vitest.setup.ts`，在测试环境也调用 `i18n.init()`：

```ts
// vitest.setup.ts (示例)
import '../web/src/i18n'
```

- [ ] **Step 9.4: 修正失败用例 + commit**

```bash
git add test/ vitest.setup.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
test: 修正 i18n 迁移后的断言

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

### Task 10: 残留扫描 + 浏览器全链路手测 + 收尾

**Files:** （无代码修改，验收性 task）

- [ ] **Step 10.1: 残留中文字面量扫描**

Run:
```bash
cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo/web/src
grep -rEnP "['\"\`][\x{4e00}-\x{9fff}\x{3400}-\x{4dbf}\x{3000}-\x{303f}\x{ff00}-\x{ffef}][^'\"\`]{0,80}['\"\`]" \
  --include="*.tsx" --include="*.ts" \
  --exclude-dir=i18n \
  | grep -v '^\s*//' \
  | grep -v 'console\.' \
  > /tmp/i18n-residue.txt
wc -l /tmp/i18n-residue.txt
```
Expected: 行数 ≤ 20，且每条都属于：
- 注释（grep 已尽量排除，但有边角）
- `new Error(...)` 抛错信息（内部 debug 用，非 UI）
- 测试 fixture（不在 web/src 范围）
- 调试日志

人工 review 这 ≤20 行，确认每条都"可接受"或顺手迁移。

- [ ] **Step 10.2: 完整构建**

Run: `cd web && npm run build`
Expected: PASS。

- [ ] **Step 10.3: 完整测试**

Run: `cd /Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo && npm test`
Expected: PASS。

- [ ] **Step 10.4: 浏览器全链路手测**

启动 dev 服务，按"用户主要使用路径"走一遍：
1. 打开应用 → 看板渲染
2. 按 `Cmd+K` → CommandPalette 全中文
3. 在 CommandPalette 中文搜索（输入"待办"、"启动"）
4. 新建一个 todo → 命名 → 看到卡片
5. 双击卡片 → SessionFocus 打开
6. 启动 AI 会话（claude） → 看状态文案
7. 输入一条消息 → 看 transcript
8. 关闭会话 → 回看板
9. 完成 / 重开 / 删除 todo
10. 打开 Wiki / Settings 抽屉
11. 切换主题

每步如有英文残留 → 回到对应 task 补 key + 改组件。

- [ ] **Step 10.5: 截图对比 PR 前后的 CommandPalette**

(可选) 截图新旧 CommandPalette 对比，附在 PR 描述里。

- [ ] **Step 10.6: 最终汇报**

把如下信息整理为最终交付摘要：
- 总修改文件数 / 新增 key 数
- 9 个 namespace 各自的 key 数
- `npm run build` 输出
- `npm test` 输出
- 残留 grep 行数及每条说明
- 浏览器手测的截图（如有）

---

## Self-Review 检查

### Spec coverage
| Spec 章节 | 对应 Task |
|---|---|
| §3 目录结构 | Task 1 |
| §4 namespace 设计 | Task 1（骨架）+ Task 2-7（填充） |
| §5 10 步迁移 | Task 1-10（一一对应） |
| §6.1 i18next 初始化代码 | Task 1.5 |
| §6.2 类型注入 | Task 1.6 |
| §6.3 组件使用模式 | Task 2.5（实例） + Task 3.3（模式说明） |
| §6.4 模板字符串处理 | Task 4.3（明确举例） |
| §6.5 不强制翻译 | Task 10.1（grep 过滤规则） |
| §6.6 cmdk 协同 | Task 2.5（局部变量重命名） |
| §6.7 收尾扫描 | Task 10.1 |
| §7 测试策略 | Task 9 |
| §8 风险与缓解 | Task 4（分批）+ Task 9（测试）+ Task 10（残留） |
| §9 验收标准 | Task 10.4 / 10.6 |

### Placeholder scan
- ✅ Task 1-2 全部为完整代码块
- ⚠️ Task 3-8 包含 "按发现的字面量填充" / "示例片段" — 这是有意的策略，因为 500+ 字符串无法在 plan 中穷举，但每个 task 都有：
  - 明确的发现命令（grep）
  - key 命名规范（namespace + 子段）
  - 标准改造模式（useTranslation + t()）
  - 构建 + 测试 + 手测 gate
- 这些不属于"placeholder"（不是 TBD / TODO），而是"框架 + 样例 + 验收 gate"的可执行模式

### Type consistency
- ✅ `t()` 始终来自 `useTranslation()` 返回的 t
- ✅ 资源结构：所有 namespace 在 Task 1 即声明（即使为空对象），后续 task 只填内容不改顶层结构
- ✅ `Resources` 类型在 Task 1.2 定义，Task 1.6 在 `declare module 'i18next'` 中引用
- ✅ Task 2.5 局部变量重命名（`t` → `todo`）说明，避免 useTranslation 冲突

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-web-i18n-react-i18next.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每个 Task 派一个 subagent 执行（task 之间在主 session review），适合长流程（10 task）减少主 session 上下文压力。

**2. Inline Execution** - 在当前 session 内按 task 顺序执行，每个 task 完成后我自检 + 给你 checkpoint。

**Which approach?**
