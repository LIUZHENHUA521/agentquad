# Web 端首次启动欢迎 Modal (Web Onboarding Welcome Modal)

- 日期：2026-05-12
- 范围：新增 `web/src/onboarding/` 目录（3 个文件）+ 改动 `web/src/TodoManage.tsx`（顶层挂载 Modal）
- 后端：无改动

## 1. 背景与问题

AgentQuad 启动后，web 端首屏对新用户信息量很大：四象限 + AI 终端 + 多个 Drawer + AttentionRail + TerminalDock。目前 web 端**没有任何新手引导**，README 和 `docs/*.md` 只对"已经知道要找文档"的用户起作用。

经过 brainstorm，确定走极简方向：

- 不做高亮 tour（power user 反感、UI 改动会让 tour 腐烂）
- 不做永久入口 Drawer（之前讨论过的 GuideDrawer 砍掉）
- **只做一个首次启动的居中 Modal**，简单介绍工具，关掉后不再弹
- 视觉走"极简苹果风"

## 2. 目标

- 首次访问 web 端弹一次居中 Modal，展示工具定位 + 3 步上手 + 一个主按钮
- 关掉后写 localStorage 标记，永不再弹
- 视觉上做到"好看"——极简苹果风：留白、细字重、灰阶 + 单一高亮色、柔和阴影、大圆角
- 零新依赖、零后端改动

非目标：

- 不做永久"上手指南"入口（点了"开始使用"就再也不出现）
- 不做 GuideDrawer / FAQ / 外链汇总
- 不做空状态自适应（不与 `todos.length === 0` 绑定，Modal 仅由 localStorage 决定）
- 不做高亮 tour / 步骤遮罩
- 不做 GIF / Lottie / SVG 插画（纯文字 + AntD icon）
- 不做 i18n（仅中文）
- 不依赖第三方动画/UI 库（不引入 framer-motion / Joyride 等）

## 3. 验收标准

- [ ] 新用户首次打开 web 端（localStorage 无 `agentquad:welcome:dismissed`）→ 自动弹出居中 Modal，显示标题、副标题、3 步上手、"开始使用"按钮
- [ ] 点击"开始使用" / Modal 关闭按钮 / 遮罩 / Esc → localStorage 写入 `agentquad:welcome:dismissed=1`，Modal 立即关闭
- [ ] 已 dismiss 的用户后续刷新页面 / 重启服务 → Modal 不再出现
- [ ] Modal 与 `todos.length` 无关（无论有无 todo，首次都会弹）
- [ ] 视觉规范全部命中（详见 §4.4）
- [ ] 移动端窄屏（<480px）：Modal 边距收紧到屏宽-32px，三步从横排变纵排，按钮不溢出
- [ ] 不新增第三方依赖（package.json `dependencies` / `devDependencies` 无新增）
- [ ] `npm run -w web build` 通过；既有测试不回归
- [ ] 新增单元测试：onboardingStore 的纯函数 `readWelcomeDismissed` / `writeWelcomeDismissed`

## 4. 设计

### 4.1 文件结构

新增：

```
web/src/onboarding/
├── WelcomeModal.tsx       # 居中欢迎 Modal
├── onboardingStore.ts     # localStorage dismissed 状态（纯函数 + 薄 hook）
└── onboarding.css         # 极简苹果风样式
```

改动：

- `web/src/TodoManage.tsx`：在顶层 JSX 末尾挂 `<WelcomeModal />`（与 Settings/Wiki 等 Drawer 同层级），由 `useWelcomeDismissed()` 控制 open 状态

**不动**的：

- 工具栏 / 移动端菜单 / Dropdown items（不加任何"上手指南"入口）
- SettingsDrawer 既有"配置教程"链接（保持原样）

### 4.2 onboardingStore.ts

纯函数 + 薄 hook，纯函数可在根 `test/` 目录跑（vitest 无 jsdom）。

```ts
const WELCOME_DISMISSED_KEY = 'agentquad:welcome:dismissed'

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

// React hook：组件内使用
export function useWelcomeDismissed(): [boolean, (v: boolean) => void] {
  const [dismissed, setDismissedState] = useState<boolean>(readWelcomeDismissed)
  const setDismissed = useCallback((v: boolean) => {
    writeWelcomeDismissed(v)
    setDismissedState(v)
  }, [])
  return [dismissed, setDismissed]
}
```

localStorage 不可用时（隐私模式）：默认 dismissed = false，setter 静默失败——表现为"每次都弹"，可接受。

### 4.3 WelcomeModal.tsx

**Props**：

```ts
interface WelcomeModalProps {
  open: boolean
  onClose: () => void   // 点关闭/遮罩/Esc/主按钮都调它
}
```

**结构**（AntD `Modal`，自定义 `footer={null}`，所有视觉控制走 CSS）：

```
┌─ Modal (width=520, centered, 圆角 20) ──────────────────┐
│                                                     ✕   │  ← 右上角细线 close
│                                                          │
│              欢迎使用 AgentQuad                          │  ← H2, 24px, 600
│                                                          │
│       四象限里的 AI 调度台 ——                           │  ← 副标题 14px, 灰 #666
│       每个待办都能跑一个 Claude/Codex 会话，全本地        │     行高 1.6
│                                                          │
│   ┌──────┐    ┌──────┐    ┌──────┐                     │
│   │  📝  │    │  🤖  │    │  ✅  │                     │  ← 三个 step icon
│   │      │    │      │    │      │                     │     icon 容器 48x48 圆 12
│   │ 新建 │    │ 启动 │    │ 协作 │                     │     灰背景 #f5f5f5
│   │ todo │    │ AI 终│    │ 完成 │                     │
│   │      │    │ 端   │    │      │                     │
│   └──────┘    └──────┘    └──────┘                     │
│   标题写你    在卡片上    关注右上                       │  ← 每步说明 13px
│   想做的事    点 "AI执行" Rail 提示                      │     灰 #555 行高 1.5
│                                                          │
│              [    开始使用    ]                          │  ← 主按钮：圆角 12
│                                                          │     高 44，宽 200
│                                                          │     主色填充
└──────────────────────────────────────────────────────────┘
```

**JSX 骨架**：

```tsx
<Modal
  open={open}
  onCancel={onClose}
  footer={null}
  centered
  width={520}
  closable
  maskClosable
  keyboard
  className="welcome-modal"
  rootClassName="welcome-modal-root"
>
  <div className="welcome-modal__body">
    <h2 className="welcome-modal__title">欢迎使用 AgentQuad</h2>
    <p className="welcome-modal__subtitle">
      四象限里的 AI 调度台 —— 每个待办都能跑一个 Claude/Codex 会话，全本地
    </p>
    <ol className="welcome-modal__steps">
      <li>
        <span className="welcome-modal__step-icon"><EditOutlined /></span>
        <span className="welcome-modal__step-label">新建 todo</span>
        <span className="welcome-modal__step-desc">标题写你想做的事</span>
      </li>
      <li>
        <span className="welcome-modal__step-icon"><RobotOutlined /></span>
        <span className="welcome-modal__step-label">启动 AI 终端</span>
        <span className="welcome-modal__step-desc">在卡片上点 "AI 执行"</span>
      </li>
      <li>
        <span className="welcome-modal__step-icon"><CheckCircleOutlined /></span>
        <span className="welcome-modal__step-label">协作完成</span>
        <span className="welcome-modal__step-desc">关注右上 Rail 提示</span>
      </li>
    </ol>
    <Button
      type="primary"
      size="large"
      onClick={onClose}
      className="welcome-modal__cta"
    >
      开始使用
    </Button>
  </div>
</Modal>
```

**Icon 选择**（AntD 自带，避免新增依赖）：

- ① 新建 → `EditOutlined`（铅笔）
- ② 启动 AI 终端 → `RobotOutlined`（机器人）
- ③ 协作完成 → `CheckCircleOutlined`（对勾）

### 4.4 视觉规范（极简苹果风）—— `onboarding.css`

**整体 Modal**：

- `.ant-modal-content` 内 padding 改成 `48px 40px 40px`（默认 AntD 24px 太挤）
- 背景纯白 `#ffffff`
- 圆角 `border-radius: 20px`
- 阴影 `box-shadow: 0 20px 60px rgba(0, 0, 0, 0.12), 0 4px 16px rgba(0, 0, 0, 0.04)`
- 遮罩 `.ant-modal-mask` 颜色加深一点：`rgba(0, 0, 0, 0.45)`，可选 `backdrop-filter: blur(2px)`（兼容性好）

**关闭按钮**（右上角"✕"）：

- 改为细线（AntD 默认就是细线），但调暗 `color: rgba(0, 0, 0, 0.35)`，hover `color: rgba(0, 0, 0, 0.85)`
- 位置 `top: 20px; right: 20px`

**标题**：

- font-size `24px`，font-weight `600`，颜色 `#1a1a1a`，letter-spacing `-0.02em`（紧字距，苹果味）
- text-align center
- margin-bottom `12px`

**副标题**：

- font-size `14px`，font-weight `400`，颜色 `#666`，line-height `1.6`
- text-align center
- max-width `380px`，居中
- margin-bottom `36px`

**三步容器**：

- `display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px`
- margin-bottom `36px`
- 每个 li：`flex column align-items: center; gap: 10px`

**Step icon 容器**：

- 尺寸 `48x48`
- 背景 `#f5f5f7`（苹果系统浅灰）
- 圆角 `14px`
- icon 自身 `font-size: 22px`，颜色 `#1a1a1a`
- 居中显示

**Step label**：

- font-size `14px`，font-weight `500`，颜色 `#1a1a1a`

**Step desc**：

- font-size `12px`，颜色 `#888`，line-height `1.5`
- text-align center

**主按钮 "开始使用"**：

- 宽度 `200px`，高 `44px`
- 圆角 `12px`
- 字号 `15px`，font-weight `500`
- 主色（沿用 AntD 默认 `#1677ff`），白字
- 容器外加 `display: flex; justify-content: center`
- 覆盖 AntD 默认 box-shadow，去掉立体感：`box-shadow: 0 1px 2px rgba(22, 119, 255, 0.2)`
- hover 颜色变浅、轻微上移 `transform: translateY(-1px)`，加 transition

**移动端**（`@media (max-width: 480px)`）：

- Modal `.ant-modal` 宽度走 `width: calc(100vw - 32px); max-width: 480px`
- 内 padding 收紧 `32px 24px 28px`
- 三步 grid 改 `grid-template-columns: 1fr`，每 li 横排（icon 左，label/desc 右）：`flex-direction: row; gap: 12px; text-align: left; align-items: center`
- 主按钮宽度变 `100%`

### 4.5 接入点（TodoManage.tsx）

**新增 import**：

```tsx
import { WelcomeModal } from './onboarding/WelcomeModal'
import { useWelcomeDismissed } from './onboarding/useWelcomeDismissed'
```

**新增 state**（与组件顶部其他 useState 同区域）：

```tsx
const [welcomeDismissed, setWelcomeDismissed] = useWelcomeDismissed()
```

**JSX 末尾挂载**（与 Settings/Wiki/Stats 等 Drawer 同层级，紧挨着即可）：

```tsx
<WelcomeModal
  open={!welcomeDismissed}
  onClose={() => setWelcomeDismissed(true)}
/>
```

就这些。**不动工具栏，不动 Dropdown，不动移动端菜单**。

## 5. 测试

### 5.1 单元测试

新增 `test/onboarding-store.test.js`（根 test/ 目录，符合现有 vitest 配置）：

mock 一个最小 localStorage 注入 `globalThis`，覆盖：

- 无 key 时 `readWelcomeDismissed()` 返回 `false`
- `writeWelcomeDismissed(true)` 后 `readWelcomeDismissed()` 返回 `true`，key 值为 `'1'`
- `writeWelcomeDismissed(false)` 后 localStorage 删掉该 key
- localStorage 抛错（mock setItem/getItem 抛异常）时不崩、`readWelcomeDismissed()` 回退到 `false`

React hook 行为不写单元测试（避免引入 jsdom + RTL），靠手动验证。

### 5.2 手动验证

| 步骤 | 期望 |
|---|---|
| 清 localStorage → 启动 web | 自动弹 Modal |
| 点"开始使用" | Modal 关闭，localStorage 有 `agentquad:welcome:dismissed=1` |
| 刷新页面 | Modal 不再出现 |
| 清 localStorage 后再刷新 | Modal 又出现 |
| 点 ✕ / 点遮罩 / 按 Esc | 等同"开始使用"，都写入 dismissed |
| 视觉对照 §4.4：圆角、阴影、字号、间距、icon 容器、按钮 | 全部命中 |
| 移动端窄屏（chrome devtools iPhone SE 320×568） | Modal 不溢出，三步纵向堆叠 |
| Modal 关闭后界面交互（新建、AI 终端等） | 一切正常，无 z-index 残留 |

## 6. 风险与回退

- **风险 1**：极简苹果风的 CSS 调优需要肉眼验收；纸面规范命中不等于看起来好看
  - **缓解**：实现后让用户在浏览器实际看一眼再 commit；必要时进入 `frontend-design` skill 做视觉迭代
- **风险 2**：AntD `Modal` 内部样式权重高，自定义 CSS 可能要用 `:where()` 或具体的 class chain
  - **缓解**：所有 selector 写成 `.welcome-modal .ant-modal-content { ... }` 这种链式形式，避免 `!important`
- **风险 3**：移动端 `useIsMobile()` 与纯 CSS `@media` 二选一
  - **决定**：用纯 CSS `@media`，不依赖 JS 判断，避免首次渲染闪烁
- **回退**：所有改动局限在 `web/src/onboarding/` 新目录 + `TodoManage.tsx` 两处插入，回退只需 `git revert` 一次
