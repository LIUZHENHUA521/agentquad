# AgentQuad UI Overhaul — AI-First Dispatch Console

**Date**: 2026-05-12
**Status**: Approved (visual direction validated via mockup)
**Owner**: lzh
**Scope**: `web/` 前端整体视觉与信息架构升级；不动后端、不动云函数、不动 CLI 行为。
**Visual reference**: `mockups/ui-overhaul-preview.html`（grid + focus mode 全屏 mockup，`python3 -m http.server` 即可预览）

## 1. 背景与动机

AgentQuad 当前 UI 现状：

- `TodoManage.tsx` 已经膨胀到 **2502 行**、`TodoManage.css` **1028 行**，反映出主页承担了过多职责。
- 7 个独立 Drawer（Settings / Stats / Report / Template / Wiki / Telegram 等）+ 多个 Modal，入口分散在顶栏。
- 视觉风格基本是 AntD 5 默认主题，没有形成"AI 调度台"这一独特定位的视觉语言。
- 没有 design tokens，颜色/间距/字号大量硬编码在 CSS 里。
- 没有 dark mode；`mobile.css` 是补丁式覆盖。
- xterm 主题与整体 UI 视觉脱节。

产品定位是"四象限里的 AI 调度台 —— 每个待办都能跑一个 Claude/Codex 会话"，但当前 UI 的视觉与交互完全没有体现这个差异化点。本次升级希望让产品**看起来像它应有的样子**：一个 dev console / mission control，而不是又一个 todo app。

## 2. 设计愿景

**"AI 调度台"作为产品定位的视觉化身。**

- **主调**：深色（默认）/ 浅色（兜底，白天/录屏/分享场景使用）
- **关键字**：高信息密度、状态实时可见、键盘优先、monospace 标记关键数据
- **视觉参考**：
  - **Linear** —— 信息架构与节奏
  - **Raycast** —— 命令面板与键盘交互
  - **Cursor** —— AI 状态可视化、subtle 电光色点缀
  - **v0** —— 视觉锐度与对比度

## 3. Design Tokens

所有 token 集中在 `web/src/design/tokens.ts`（JS 引用）和 `tokens.css`（CSS variables，注入到 `:root` 与 `[data-theme="light"]`）。

### 3.1 Color

**Surface 层级**（深色为基准，浅色镜像）：

| Token | 用途 |
|---|---|
| `--surface-0` | App 背景 / canvas |
| `--surface-1` | 卡片、面板默认背景 |
| `--surface-2` | hover、active state |
| `--surface-3` | popover、modal、command palette |

**Border**：`--border-subtle` / `--border-default` / `--border-strong`

**Text**：`--text-primary` / `--text-secondary` / `--text-tertiary` / `--text-disabled`

**Brand accent**：

- `--accent-electric: #4DE5FF` —— 电光蓝主色，用于 AI 状态、focus ring、primary action 强调
- `--accent-electric-soft` —— 同色 12% alpha，用于 background tint
- `--accent-electric-glow` —— 用于 thinking 状态的呼吸辉光

**语义色**：

- **Quadrant**：
  - `--q1` magenta（紧急 + 重要）
  - `--q2` electric blue（重要不紧急）
  - `--q3` amber（紧急不重要）
  - `--q4` neutral（不紧急不重要）
- **AI session 状态**：
  - `--ai-running` green pulse
  - `--ai-thinking` electric blue
  - `--ai-pending-confirm` amber
  - `--ai-idle` gray
  - `--ai-error` red

### 3.2 Spacing

8-point grid：`--space-1..9` = 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64 px。

### 3.3 Typography

| Token | Stack | 用途 |
|---|---|---|
| Sans | Inter, system-ui, -apple-system | UI 主字体 |
| Mono | JetBrains Mono, SF Mono, Menlo | terminal、token 数字、状态码、shortcut hint |

字号阶梯：`--text-xs` 11 / `--text-sm` 12 / `--text-base` 13 / `--text-md` 14 / `--text-lg` 16 / `--text-xl` 20 / `--text-2xl` 24。

默认 13px（高密度调度台调性）。

### 3.4 Radius / Shadow / Motion

- **Radius**：`--radius-sm` 4 / `--radius-md` 6 / `--radius-lg` 8 / `--radius-xl` 12 / `--radius-full` 999
- **Shadow**：3 档 —— subtle / elevated / floating；dark 模式叠 inset highlight + outer drop
- **Motion**：3 档 duration = 120 / 200 / 320 ms；3 档 easing = standard / in / out / spring

## 4. 信息架构调整

### 4.1 顶栏改造为"调度面板"

**当前**：工具按钮排排坐，没有状态展示。

**新版**：
```
[Logo] [● 3 active] [▲ 24.5k tok] [⚠ 1 pending] ─── [⌘K] [📊] [⚙] [🌙]
```

- 左侧实时状态：活跃会话数（带脉动点）/ token 累计（mono）/ pending_confirm 告警（有就高亮 amber）
- 右侧操作入口：⌘K 命令面板 / Stats drawer / Settings drawer / theme toggle
- Logo 区域可点击回到主看板

### 4.2 ⌘K 命令面板（新增）

- 触发：⌘K / Ctrl+K（全局）
- 覆盖动作：
  - 新建 todo（带象限选择）
  - 跳转象限（Q1-Q4）
  - 跳转/聚焦 todo（按标题模糊搜索）
  - 启动 AI（claude / codex）
  - 切换主题（light / dark）
  - 打开任意 drawer（Settings / Stats / Wiki / Template / Telegram）
- 实现选型：优先用 [`cmdk`](https://github.com/pacocoursey/cmdk)；如果集成成本高，自写一个简化版（搜索 + ↑↓ + Enter）

### 4.3 Drawer 整合（7 → 4）

| 原 Drawer | 处理 |
|---|---|
| Settings | 保留独立 |
| Wiki | 保留独立 |
| Stats | 与 Report 合并为单一 drawer 多 tab |
| Report | 同上 |
| Template | 下沉到 ⌘K，不再常驻顶栏按钮 |
| Telegram (probe / sync) | 下沉到 ⌘K + Settings 内子页面 |
| 其他临时 drawer | 评估后下沉或合并 |

### 4.4 Hero 卡片（TodoCard 重做）

```
┌─────────────────────────────────┐
│ Q1 ●  优化首屏性能              │  ← quadrant dot + title
│ ─────────────────────────────── │
│ [claude] running ▶ 12m          │  ← AI status row (mono)
│ ▁▃▅▇▅▃▁▁  2.4k tok              │  ← activity sparkline + tokens
│ #perf #frontend       ⌘ focus  │  ← tags + keyboard hint
└─────────────────────────────────┘
```

- 顶部：象限色点 + 标题
- AI 状态行：tool 名称（mono）+ 状态 + 运行时长
- Activity sparkline：**基于已有的 AI 会话消息事件频率**（WS 推送的 message 计数，每 N 秒一个 bucket），不依赖新增后端字段。真实 token rate（per-todo 窗口）当前后端无此数据，列入 stretch / 后续迭代
- 底部：标签 + 键盘焦点提示
- hover 时浮出操作按钮：fork / archive / open terminal

### 4.5 AI 终端可视化升级

- 默认收起，只显示状态条（带电光色 thinking 呼吸动画）
- 点击展开：分屏 —— 左侧 conversation 渲染（已有 `TranscriptView`）/ 右侧 raw xterm
- "thinking" 状态用 `--accent-electric` 脉动呼吸（CSS animation）
- xterm 主题与 design token 对齐（`terminalThemes.ts` 接入 token）
- **xterm 切换主题的实现注意**：xterm 渲染到 canvas/WebGL，**不能仅靠 CSS 变量**。切主题时必须重置 `terminal.options.theme = newTheme` 并触发 `terminal.refresh(0, terminal.rows - 1)`，确保 scrollback 历史输出也变色

## 5. 组件清单

| 组件 | 处理策略 |
|---|---|
| Button / Input / Select / Form / Modal / Drawer / Popover / Table / Tabs / Tooltip | **AntD + token override**（通过 ConfigProvider theme） |
| **TodoCard** | 自建 hero 组件 |
| **TopbarDispatch** | 自建 |
| **CommandPalette** | 自建（cmdk 或自写） |
| **AiStatusBadge** | 自建 |
| **ActivitySparkline** | 自建（SVG，无第三方库） |
| **QuadrantBoard** | 自建（从 TodoManage 拆出） |
| **ThemeToggle** | 自建 |
| **QuadrantHeader** | 自建（每个象限的标题区） |

## 6. 文件结构调整

```
web/src/
├── design/                        # 新增
│   ├── tokens.ts                  # JS 引用入口 + 动画预设（duration / easing 直接放这）
│   ├── tokens.css                 # CSS variables（light + dark）
│   ├── antd-theme.ts              # AntD ConfigProvider theme（映射 token）
│   └── ThemeProvider.tsx          # React Context + data-theme 切换 + localStorage 持久化
├── components/                    # 新增（自建 hero 组件）
│   ├── TodoCard/
│   ├── TopbarDispatch/
│   ├── CommandPalette/
│   ├── AiStatusBadge/
│   ├── ActivitySparkline/
│   ├── QuadrantBoard/             # 从 TodoManage 拆出
│   ├── QuadrantHeader/
│   └── ThemeToggle/
├── TodoManage.tsx                 # 拆到 ≤ 400 行（只编排，不实现具体 UI）
├── TodoManage.css                 # 大幅瘦身，保留布局粘合
└── ...（其他文件保持原位置）
```

`mobile.css` 在 M4 阶段做响应式审查，能融入 `tokens.css` / 组件 CSS 的就融入。

## 7. 主题切换实现

- React Context + `data-theme` 属性切换
- 用户选择存到 localStorage
- 默认跟随系统（`prefers-color-scheme`），首次访问应用系统偏好
- AntD 通过 `ConfigProvider theme={dark ? darkTheme : lightTheme}` 切换
- xterm 主题在 useEffect 中跟随切换

## 8. 里程碑

每个里程碑独立可 ship、独立 PR、独立验证。

### M1 (W1) — Design tokens + AntD theme + dark mode 基础设施

**交付**：
- `web/src/design/` 全部文件（tokens、CSS variables、ConfigProvider theme、ThemeProvider）
- 主题切换按钮可用，所有 AntD 组件随主题变
- xterm 主题接入 token，切主题时正确 refresh
- **迁移所有静态 `message.*` / `notification.*` / `Modal.confirm` 调用**为 `App.useApp()` hook 形式（当前 `TranscriptView`、`TemplateDrawer`、`ForkDialog`、`ExportDialog` 等至少 6 处使用），否则 toast / 通知不会跟着主题变

**验证**：
- 手动切 light/dark，所有 AntD 组件不裸露默认色（包含 toast / notification / confirm）
- xterm 配色随之变，scrollback 历史输出也变
- **`rg '#[0-9a-fA-F]{3,8}' web/src --type css` 输出为空**（除 design tokens.css 自身定义处外）

### M2 (W2) — 顶栏调度面板 + ⌘K 命令面板

**交付**：
- `TopbarDispatch` 替换原 topbar
- `CommandPalette` 上线，覆盖 README 提到的核心动作
- 主题 toggle 收纳到顶栏

**验证**：⌘K 能完成"新建 todo / 跳转象限 / 启动 AI / 切主题 / 打开 drawer"五类核心动作；顶栏实时状态数字与现有数据源对齐。

### M3 (W3) — Hero TodoCard + QuadrantBoard 重构 + TodoManage 拆分 + 终端状态条

**交付**：
- `TodoCard` 取代当前卡片
- `QuadrantBoard` / `QuadrantHeader` 从 TodoManage 拆出
- `TodoManage.tsx` 行数大幅瘦身（**目标 ≤ 400 行**；如确实拆不到，最低门槛 ≤ 600 行 + 在 PR 描述里说明剩余职责）
- Activity sparkline（基于 WS 消息频率，不依赖新增后端字段）
- AI 终端状态条 + thinking 呼吸动画（嵌在卡片上）

**验证**：
- 拖拽路径回归：象限间拖拽 / 象限内重排 / AI 会话运行中拖拽 / 键盘 sensor（如有）
- 新建 / 删除 / 归档 / 编辑全路径回归
- 视觉对照 token；hero 卡片在 light/dark 下都正确

### M4 (W4) — 终端分屏 + drawer 整合 + mobile + 收尾

**交付**：
- AI 终端展开分屏（左 conversation 渲染 / 右 raw xterm）
- Stats + Report drawer 合并
- Template / Telegram 下沉到 ⌘K（旧入口移除前确保 ⌘K 路径覆盖等效功能）
- mobile 响应式审查（iPhone Safari 走核心路径）
- 全 UI 一致性 walkthrough，修补遗留

**验证**：
- 全 UI 在 light/dark 都无残留旧色
- iPhone Safari 上看板 / AI 终端可读可用
- 浏览器 perf timeline 对比首屏与 xterm mount 不退化
- 旧 Template / Telegram drawer 调用方均已迁移到 ⌘K 或 Settings 子页

## 9. 验证策略

| 维度 | 方法 |
|---|---|
| 视觉一致性 | 每个页面 light/dark 截图对照 token；用 design token 文档作为 source of truth |
| 关键路径回归 | 新建 todo / 启动 AI（claude + codex）/ 切象限 / 拖拽 / Telegram 同步 / Wiki 查看 / Stats 查看 |
| 主题切换 | light ↔ dark 反复切，无残留旧色、无闪烁 |
| Mobile | iPhone Safari 走核心路径（Tailscale 远程） |
| 性能 | 浏览器 perf timeline 对比首屏 paint + xterm mount |
| 已有测试 | `test/telegram-config.route.test.js` 等后端测试不破坏；前端无单测，本次**不补**（保持现状） |

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| AntD 视觉痕迹"洗不掉" | 接受 AntD 在二级组件上的痕迹；hero 组件全自建，集中在用户高频可见处 |
| dark mode 改造范围大（CSS 硬编码颜色多） | M1 一次性梳理，扫描所有硬编码 hex/rgb 替换为 token |
| TodoManage 拆分破坏 dnd-kit / 拖拽逻辑 | M3 拆分时先抽组件再调样式；拆完按以下场景逐一回归：象限间拖拽 / 象限内重排 / AI 会话运行中拖拽不丢状态 / 拖拽过程中卡片 hover 操作不误触 |
| 性能退化（卡片实时 sparkline + 脉动动画） | sparkline 限频更新（≥ 1s/帧）；脉动用 CSS animation 不用 JS |
| 4 周时间被新需求打断 | 每个 milestone 独立 ship，被打断也有阶段性收益 |

## 11. 范围之外（明确不做）

- README 列的 18 项后续功能（除非顺手做不增成本）
- 替换 AntD 底座
- A11y 专项审计（顺带不专门）
- i18n
- 后端任何改动（路由、telegram-bot、CLI 等）
- 前端单元测试补全

## 12. 验收标准

| 维度 | 标准 | 检查方式 |
|---|---|---|
| 视觉一致性 | 所有页面/Drawer 走同一份 design token | `rg '#[0-9a-fA-F]{3,8}' web/src --type css` 输出为空（除 tokens.css 自身） |
| 可维护性 | `TodoManage.tsx` ≤ 400 行（最低门槛 ≤ 600 行） | `wc -l web/src/TodoManage.tsx` |
| CSS 瘦身 | `TodoManage.css` 量级目标 ≤ 300 行 | `wc -l web/src/TodoManage.css` |
| 关键路径不退化 | 核心动作 click 数 ≤ 现状 | 手动 walkthrough：新建 / 启动 AI / 切象限 / 拖拽 / Telegram 同步 |
| Dark mode | 全 UI 在 light / dark 下均可读、无残留旧色 | 手动 walkthrough，包含 toast / notification / modal confirm / xterm scrollback |
| Mobile | iPhone Safari 上四象限可用、AI 终端可读 | iPhone Safari + Tailscale 实测 |
| 性能 | 首屏 paint 不退化；xterm mount 不退化 | 浏览器 perf timeline 前后对比 |
| 主观体验（北极星） | 自己用一周后觉得"比之前更愿意打开" | 主观判断，不作为单 PR 阻塞条件 |

## 13. Open questions（执行前需确认默认值）

| # | 问题 | 默认建议 |
|---|---|---|
| Q1 | CommandPalette 用 `cmdk` 还是自写？ | **优先 cmdk**；如果 bundle 体积或样式定制成本高，则自写简化版（搜索 + ↑↓ + Enter） |
| Q2 | TodoCard 的 Activity sparkline 数据源 | **基于已有 WS 消息事件计数**（每 N 秒一个 bucket）；真实 token rate 列入 stretch / 后续迭代（需要新增后端字段） |
| Q3 | Template / Telegram drawer 下沉 ⌘K 后，旧路由入口是否保留 | **保留（兜底）**：⌘K 是新主路径，但旧入口短期保留以防回归；M4 验证完成后再决定是否移除 |
| Q4 | mobile 适配的边界 | **核心路径可用即可**：四象限浏览 / 看 todo 详情 / 看 AI 输出可读；不追求拖拽 / 多手势 / 原生 app 质感 |

如果对默认值有不同意见，在执行 plan 之前调整本节即可。
