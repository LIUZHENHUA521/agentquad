# 信息架构整理（方案 A）设计

- 日期：2026-05-09
- 范围：quadtodo web 前端（`web/src/`）— 顶栏 + Drawer 管理
- 后端：无改动

## 背景

dock 重构（方案 B，已合并）解决了"AI 终端没地方住"的问题。但顶栏依旧塞了 11 个按钮，多个 Drawer 互相不知道对方存在——开 Settings 再开 Stats，ESC 一下两个都关掉，找不到原来在哪。

## 目标

1. **顶栏分组**：可见入口收到 ≤ 5 个高频按钮；其余进 ⋯ 下拉，1 次点击可达
2. **Drawer 统一管理**：建立 DrawerStack，多 Drawer 同时打开时 ESC 只关掉最上层一个，返回上一层

## 非目标

- **不做 SettingsDrawer 二级导航重排**（Plan A 第 3 项）：用户 WIP 在改 SettingsDrawer.tsx（Telegram/Lark 集成），此次不冲突；待 WIP 落地后单独做
- 不动卡片、看板、Dock、Pet 相关代码
- 不动后端、API 协议

## 设计

### Phase 1：顶栏分组

**保留可见**（高频）：
- 新建（PlusOutlined）
- 全局搜索（SearchOutlined，⌘K）
- AI 面板（DashboardOutlined）
- 设置（SettingOutlined）
- 自动填入 switch（不算按钮，不动）

**收进 ⋯ 更多 下拉**：
- TelegramSyncButton（保留组件本体不动；仅放进下拉的 menu item 里）
- 找回（TranscriptSearchDrawer）
- 模板（TemplateDrawer）
- 报表（ReportDrawer）
- 记忆（WikiDrawer）
- 统计（StatsDrawer）

下拉用 antd `Dropdown` + `menu` items；每项 icon + label + onClick 调原 setter。

**移动端不变**：现有 mobileMenuOpen 抽屉已经做了类似事，不动。

### Phase 2：DrawerStack

**问题**：多个 Drawer 同时开时，antd 默认 ESC 行为会触发多个 Drawer 的 onClose（每个 Drawer 各自监听 keydown），可能同时关闭。

**方案**：

新建 `web/src/store/drawerStackStore.ts`（Zustand）：

```ts
type DrawerKey = string  // e.g. 'settings', 'stats', 'report', ...

interface DrawerStackState {
  stack: DrawerKey[]   // open order, top = last element
  push: (key: DrawerKey) => void
  pop: (key: DrawerKey) => void  // remove key (might not be top)
  topKey: () => DrawerKey | null
}
```

新建 hook `web/src/hooks/useDrawerStack.ts`：

```ts
function useDrawerStack(key: DrawerKey, open: boolean): {
  isTopmost: boolean   // 仅当本 drawer 是 stack 顶才接管 ESC
}
```

每个 Drawer 改造（最少侵入）：
- 在 TodoManage 渲染 Drawer 时，传入 `keyboard={false}`（关闭 antd 自带 ESC）
- 用 `useDrawerStack(key, open)` 注册自身
- 顶层 useEffect 监听 document keydown：ESC → 调 `topKey()` 对应的 onClose

**实现策略**：单一 useEffect 监听 document keydown，在 TodoManage 顶层。ESC 按下时调度到 stack top 的 onClose（用一个 onClose registry 维护）。

```ts
const closeRegistry = useRef<Record<DrawerKey, () => void>>({})
// 每个 Drawer 把自己的 onClose 注册进来
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    const top = drawerStack.topKey()
    if (top && closeRegistry.current[top]) {
      closeRegistry.current[top]()
      e.stopPropagation()
    }
  }
  document.addEventListener('keydown', handler, true)
  return () => document.removeEventListener('keydown', handler, true)
}, [])
```

**涉及的 Drawer**：SettingsDrawer、StatsDrawer、ReportDrawer、TemplateDrawer、WikiDrawer、DashboardDrawer、TranscriptSearchDrawer、PipelineRunDrawer。

**SettingsDrawer 注意**：因 WIP 冲突，**不修改其文件本身**，但要传 `keyboard={false}` prop。如果 SettingsDrawer.tsx 内部接受这个 prop 透传给 antd Drawer 即可（antd Drawer 默认接受 `keyboard`）。如果 SettingsDrawer 写了硬编码 `keyboard={true}`，跳过它，注释一下。

## 验收

**Phase 1**：
- 桌面端工具栏可见按钮 ≤ 5 个
- ⋯ 下拉里能看到所有原入口，每项 1 次点击就能打开对应 Drawer
- 移动端工具栏不变

**Phase 2**：
- 同时开 ≥ 2 个 Drawer，按 ESC 只关闭最近开的那个
- 关掉最上层后，下层 Drawer 仍可见可交互
- 关 Drawer 走 ✕ 按钮 / 点 mask 行为不受影响（antd 自带）
- 没有任何 Drawer 因为这次改动出现"打不开"或"关不掉"

**全局**：
- tsc / vite build 通过
- 后端无改动
- 用户 WIP（SettingsDrawer.tsx 等）不被触及
