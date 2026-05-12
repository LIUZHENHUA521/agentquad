# Web 端新手引导 (Web Onboarding Guide)

- 日期：2026-05-12
- 范围：新增 `web/src/onboarding/` 目录（3 个文件）+ 改动 `web/src/TodoManage.tsx`（sticky header 工具栏与下方区域）
- 后端：无改动

## 1. 背景与问题

AgentQuad 启动后，web 端首屏对新用户信息量很大：

- 四象限视图 + 优先级视图切换
- 每个 todo 上的 AI 终端、Fork、导出、复制 prompt 等多个操作
- 工具栏含找回、设置、模板、报表、记忆、统计、Telegram 同步等多个 Drawer
- 右侧 AttentionRail 提示流、底部 TerminalDock

目前 web 端**没有任何新手引导**。已有的 README、`docs/*.md`、SettingsDrawer 里的"配置教程（不熟悉的话点开看）"链接是为 *已知道要去找文档* 的用户准备的，对从浏览器进来直接看到界面的新人帮助有限。

用户原话："宝子，我这个工具，你觉得启动 web 端后，需要有一个新手教程吗？"

经过 brainstorm，结论是：**需要做，但不做高亮巡览**——AgentQuad 的目标用户是技术开发者，强弹窗/tour 会反感；同时界面仍在频繁迭代，tour 步骤会快速腐烂。

## 2. 目标

提供轻量、不打扰、长期可维护的新手引导：

1. **首次空状态**自动给出 3 步上手提示（不是模态弹窗）
2. **永久入口**让任何时候都能查阅完整指南，不会"关了找不回"
3. **不引入新依赖**（不要 Joyride / Driver.js 这类）

非目标：

- 不做高亮 tour / 步骤遮罩
- 不做 GIF / 截图（避免维护负担；纯文字 + AntD icon）
- 不做后端持久化（localStorage 即可，AgentQuad 是本地单用户工具）
- 不做 i18n（仅中文，与界面主体一致）
- 不替换 SettingsDrawer 既有"配置教程"链接（两者并存：那是 AI tool 安装教程，本 spec 是产品功能引导）

## 3. 验收标准

- [ ] 新用户首次打开 web 端（localStorage 无 `agentquad:welcome:dismissed`，且 `todos.length === 0`），sticky header 下方显示 WelcomeCard 横幅，列出 3 步上手
- [ ] WelcomeCard 上"立即新建"按钮等价于点击工具栏"新建"，打开 `handleCreate()` 新建 Drawer
- [ ] WelcomeCard 上"完整指南"按钮打开 GuideDrawer
- [ ] WelcomeCard 上"我知道了，不再显示"按钮写入 `agentquad:welcome:dismissed=1`，立即隐藏；后续即使清空 todo 也不再出现
- [ ] 已有任意 todo 的用户（`todos.length > 0`）看不到 WelcomeCard
- [ ] sticky header 工具栏"更多" Dropdown 末尾新增一项"上手指南"（icon: `QuestionCircleOutlined`），点击打开 GuideDrawer
- [ ] 移动端 `mobileMenuOpen` 菜单也包含"上手指南"项
- [ ] GuideDrawer 包含 5 个分区：30 秒上手 / 主要功能简介 / 进阶玩法（外链）/ 没装 claude/codex（跳 Settings）/ FAQ
- [ ] GuideDrawer 中"去设置 → 配置教程"按钮关闭 GuideDrawer 并打开 SettingsDrawer
- [ ] 进阶玩法外链指向 GitHub 仓库（`https://github.com/LIUZHENHUA521/agentquad/blob/main/docs/MCP.md` 等），`target="_blank"` + `rel="noopener noreferrer"`
- [ ] 移动端窄屏（<480px）：WelcomeCard 三步纵向堆叠，按钮不溢出；GuideDrawer 变全宽
- [ ] 不新增第三方依赖（package.json `dependencies` / `devDependencies` 无新增）
- [ ] `npm run -w web build` 通过；既有用例不回归
- [ ] 新增最小化单元测试：onboardingStore 的 localStorage 读写

## 4. 设计

### 4.1 文件结构

新增：

```
web/src/onboarding/
├── WelcomeCard.tsx       # 首次空状态横幅
├── GuideDrawer.tsx       # 永久可访问的上手指南 Drawer
└── onboardingStore.ts    # localStorage dismissed 状态 hook
```

改动：

- `web/src/TodoManage.tsx`：
  - sticky header 下方挂 `<WelcomeCard ... />`（条件渲染）
  - "更多" Dropdown items 末尾追加 "guide" 项
  - 移动端 menu（`mobileMenuOpen` 内）同步追加
  - 顶层 state 增加 `guideOpen` + `<GuideDrawer open={guideOpen} ... />`

### 4.2 onboardingStore.ts

暴露**纯函数**（不依赖 React），再加一个薄 hook 给组件用。这样 store 测试可以直接在根 `test/` 目录跑，不需要 jsdom。

```ts
const WELCOME_DISMISSED_KEY = 'agentquad:welcome:dismissed'

// 纯函数：可单独测试
export function readWelcomeDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(WELCOME_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeWelcomeDismissed(v: boolean): void {
  try {
    if (v) globalThis.localStorage?.setItem(WELCOME_DISMISSED_KEY, '1')
    else globalThis.localStorage?.removeItem(WELCOME_DISMISSED_KEY)
  } catch { /* 隐私模式等异常静默 */ }
}

// React hook：薄包装，组件内使用
export function useWelcomeDismissed(): [boolean, (v: boolean) => void] {
  const [dismissed, setDismissedState] = useState<boolean>(readWelcomeDismissed)
  const setDismissed = useCallback((v: boolean) => {
    writeWelcomeDismissed(v)
    setDismissedState(v)
  }, [])
  return [dismissed, setDismissed]
}
```

- 不监听 `storage` 事件（单浏览器标签场景足够）
- localStorage 不可用时（隐私模式）：默认 dismissed = false，setter 静默失败——表现为"每次都显示"，可接受

### 4.3 WelcomeCard.tsx

**Props**：

```ts
interface WelcomeCardProps {
  onCreate: () => void       // 复用 TodoManage 的 handleCreate
  onOpenGuide: () => void    // 打开 GuideDrawer
  onDismiss: () => void      // 写 dismissed
}
```

**布局（桌面端）**：

```
┌─ .welcome-card ────────────────────────────────────────────────────┐
│ 👋 欢迎使用 AgentQuad！3 步开始：                       [✕ 关闭]   │
│                                                                     │
│ ┌─ ① 新建 todo ──┐ ┌─ ② 启动 AI 终端 ──┐ ┌─ ③ 协作完成 ───────┐ │
│ │ 标题写你想做的 │ │ 在卡片上点"AI    │ │ 关注 AttentionRail │ │
│ │ 事             │ │ 执行"，让        │ │ 提示，跟 AI 聊到   │ │
│ │ [立即新建]     │ │ claude/codex 接手│ │ 搞定               │ │
│ └────────────────┘ └──────────────────┘ └────────────────────┘ │
│                                                                     │
│ [📖 完整指南]                            [我知道了，不再显示]      │
└─────────────────────────────────────────────────────────────────────┘
```

- 容器：AntD `Card` 或自定义 div，浅色背景（不要太抢眼）
- 顶行：标题 + 右上角"✕"快速关闭（等同"我知道了"）
- 中间：3 张小卡，flex 横排；窄屏纵向堆叠
- 底行：左侧"完整指南"按钮（`type="default"`，icon: `BookOutlined`），右侧"我知道了"链接按钮（`type="link"`）

**显示条件**（在 TodoManage 中判断，不在 WelcomeCard 内）：

```tsx
{!welcomeDismissed && totalTodoCount === 0 && (
  <WelcomeCard onCreate={handleCreate} onOpenGuide={() => setGuideOpen(true)} onDismiss={() => setWelcomeDismissed(true)} />
)}
```

**`totalTodoCount` 来源（关键点）**：`TodoManage.tsx` 现有 `todos` state（行 708）受 `filterStatus`/`keyword` 影响——`fetchTodos` 把这俩作为参数传给 `listTodos`（行 979-983），所以不能直接用 `todos.length` 当 raw count。

实现方案：

1. 新增 state `const [totalTodoCount, setTotalTodoCount] = useState<number | null>(null)`（null = 还未拿到，避免首次渲染闪现 WelcomeCard 又消失）
2. 初次挂载用 `useEffect` 调一次 `listTodos({})`（不带 filter）取总数 → `setTotalTodoCount(list.length)`
3. CRUD 后**懒同步**：在 `handleCreate` 成功（子函数：保存新建 Drawer 时）+ `handleDelete` 成功后，重新调一次 `listTodos({})` 更新；或者更简单——CRUD 后直接 `setTotalTodoCount(prev => prev + 1 / prev - 1)`。删除子树时数量不止 -1，所以**统一用 re-fetch 法**，但只在 `welcomeDismissed === false` 时执行（dismissed 之后不再需要这个数）
4. 显示条件改为：`!welcomeDismissed && totalTodoCount === 0`（注意 null 不等于 0，所以拿到数据前不会显示）

简化版数据流：

```tsx
const [totalTodoCount, setTotalTodoCount] = useState<number | null>(null)

useEffect(() => {
  if (welcomeDismissed) return  // 已 dismiss 就不需要再算了
  listTodos({}).then(list => setTotalTodoCount(list.length)).catch(() => {})
}, [welcomeDismissed])

// CRUD 后触发重新计数
const refreshTotalCount = useCallback(() => {
  if (welcomeDismissed) return
  listTodos({}).then(list => setTotalTodoCount(list.length)).catch(() => {})
}, [welcomeDismissed])

// 在 handleCreate(保存成功)、handleDelete、handleToggleDone 等成功回调里调 refreshTotalCount()
```

- 一旦 `totalTodoCount > 0`，立即隐藏；用户主动 dismiss 后即使数量又变回 0 也不再显示

**样式**：新建 `web/src/onboarding/onboarding.css` 或追加到 `TodoManage.css`（推荐前者，独立模块）

### 4.4 GuideDrawer.tsx

**Props**：

```ts
interface GuideDrawerProps {
  open: boolean
  onClose: () => void
  onOpenSettings: () => void   // 点 "去设置 → 配置教程" 时调用
}
```

**Drawer 配置**：标题"AgentQuad 上手指南"，placement="right"。桌面端 `width={560}`，移动端（`useIsMobile()` 命中）切换到 `width="100%"`，避免窄屏溢出（参考 `web/src/hooks/useIsMobile.ts`）。

**内容（5 个分区，纯静态）**：

1. **30 秒上手**
   - 展开 WelcomeCard 三步：每步加 1-2 句关键说明
   - 第 1 步末尾："标题就是给 AI 的 prompt——写清楚要做什么"
   - 第 2 步末尾："首次启动 AI 会用 claude（默认），可在设置里切到 codex"
   - 第 3 步末尾："AI 卡到需要决策的地方会推送到 AttentionRail，点开继续聊"

2. **主要功能**（每项一行）
   - 四象限视图 / 优先级视图（顶部切换）
   - AI 终端（todo 卡片上的"AI 执行"）
   - AttentionRail（右上角提示流）
   - 记忆 Wiki（项目长期记忆）
   - 模板（常用 prompt 复用）
   - 报表 / 统计（活跃度回顾）
   - 找回（历史会话恢复）
   - 设置（端口、默认工具、Telegram 等）

3. **进阶玩法**（外链卡片，点击新窗口打开）
   - MCP：让外部 Claude Code 操作你的 todo（`docs/MCP.md`）
   - Telegram：每个 todo 一个 Topic，手机端跟 AI 对话（`docs/TELEGRAM.md`）
   - OpenClaw：微信里调用 AgentQuad（`docs/OPENCLAW.md`）
   - 手机访问：Tailscale 私网（`docs/MOBILE.md`）

   外链格式：`https://github.com/LIUZHENHUA521/agentquad/blob/main/docs/<name>.md`（仓库地址从 README 取）

4. **没装 claude / codex？**
   - 一句话提示：AI 终端依赖 `claude` 和 `codex` 这两个命令
   - 按钮："去设置 → 配置教程" → 关闭本 Drawer，打开 SettingsDrawer

5. **常见问题（FAQ）**
   - AI 终端打开后没反应？→ 跑 `agentquad doctor` 看 claude/codex 是否在 PATH
   - 之前的会话能找回吗？→ 顶部工具栏的"找回"按钮
   - 想关掉欢迎横幅但又想再看？→ 清浏览器 localStorage 的 `agentquad:welcome:dismissed`
   - 移动端访问？→ 见"进阶玩法 / 手机访问"
   - 数据存哪里？→ `~/.agentquad/`

### 4.5 接入点变更（TodoManage.tsx）

**新增 state**：

```tsx
const [guideOpen, setGuideOpen] = useState(false)
const [welcomeDismissed, setWelcomeDismissed] = useWelcomeDismissed()
const totalTodoCount = /* 实现时确认数据来源，见 4.3 */
```

**Sticky header 下方挂横幅**（行 1740 附近，`</div>` 关闭 sticky-header 之后、`viewMode === 'priority'` 之前）：

```tsx
{!welcomeDismissed && totalTodoCount === 0 && (
  <WelcomeCard
    onCreate={handleCreate}
    onOpenGuide={() => setGuideOpen(true)}
    onDismiss={() => setWelcomeDismissed(true)}
  />
)}
```

**Dropdown items 追加**（行 1729 数组末尾）：

```ts
{
  key: 'guide',
  icon: <QuestionCircleOutlined />,
  label: '上手指南',
  onClick: () => setGuideOpen(true),
},
```

**移动端 menu 内同步追加**（找到 `mobileMenuOpen` 渲染的 menu 位置）。

**底部挂 Drawer**（与 Settings / Wiki / Stats 等 Drawer 同层级）：

```tsx
<GuideDrawer
  open={guideOpen}
  onClose={() => setGuideOpen(false)}
  onOpenSettings={() => {
    setGuideOpen(false)
    setSettingsOpen(true)
  }}
/>
```

## 5. 测试

### 5.1 单元测试

新增 `test/onboarding-store.test.js`（根 test/ 目录，符合现有 vitest 配置——`vitest.config.js` 只设 `pool: 'vmThreads'`，没启用 jsdom，所以**只测纯函数**，不测 React hook）。

mock 一个最小 localStorage 注入到 `globalThis`，覆盖：

- 无 key 时 `readWelcomeDismissed()` 返回 `false`
- `writeWelcomeDismissed(true)` 后 `readWelcomeDismissed()` 返回 `true`，localStorage 里 key 值为 `'1'`
- `writeWelcomeDismissed(false)` 后 localStorage 删掉该 key
- localStorage 抛错（mock 的 setItem/getItem 抛异常）时函数不崩、`readWelcomeDismissed()` 回退到 `false`

React hook 行为不写单元测试（避免引入 jsdom + RTL），靠手动验证覆盖。

### 5.2 手动验证

| 步骤 | 期望 |
|---|---|
| 清 localStorage + 无 todo → 启动 web | 看到 WelcomeCard 横幅 |
| 点"立即新建" → 填标题保存 | 横幅消失 |
| 删除所有 todo | 横幅再次出现（dismissed 未写） |
| 点"我知道了" | 横幅立即消失，localStorage 有 `agentquad:welcome:dismissed=1` |
| 再清空 todo → 刷新 | 横幅不再出现 |
| 工具栏"更多" → "上手指南" | GuideDrawer 打开 |
| GuideDrawer 进阶玩法链接 | 新窗口打开 GitHub `docs/*.md` |
| GuideDrawer "去设置 → 配置教程" | GuideDrawer 关闭、SettingsDrawer 打开 |
| 移动端窄屏 | WelcomeCard 三步纵向堆叠；GuideDrawer 全宽 |

## 6. 风险与回退

- **风险 1**：`totalTodoCount` re-fetch 在 CRUD 频繁的场景下有额外开销
  - **缓解**：仅在 `welcomeDismissed === false` 时计算；一旦 dismiss 即停止
- **风险 2**：FAQ 内容随 UI 迭代失效
  - **缓解**：FAQ 都是稳定问题（doctor、找回、localStorage、数据目录），不引用具体 UI 坐标
- **风险 3**：进阶玩法 GitHub 链接的仓库名变化（如再次改名）会全部失效
  - **缓解**：仓库 URL 集中放一个常量（如 `web/src/onboarding/links.ts`），后续改名只改一处
- **回退**：所有改动局限在 `web/src/onboarding/` 新目录 + `TodoManage.tsx` 几处 hook 点，回退只需 `git revert` 一次
