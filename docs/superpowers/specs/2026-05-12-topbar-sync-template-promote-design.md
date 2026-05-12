# 顶栏同步与模板入口提升设计

- 日期：2026-05-12
- 范围：AgentQuad Web 顶栏入口调整（`web/src/TodoManage.tsx`）
- 后端：无改动
- 方案：A

## 背景

当前桌面端顶栏将「同步对账」和「模板」收在「更多」下拉里。截图需求要求把这两项「单独放出来」，也就是把它们提升为顶栏可见入口，减少高频操作的点击层级。

现有实现中：

- 「同步对账」由 `TelegramSyncButton` 承载，内部已有 dry-run 预览、确认执行、loading、结果提示。
- 「模板」由 `TemplateDrawer` 承载，`TodoManage` 里已有 `templateDrawerOpen` 状态和 drawer stack 注册。
- 移动端使用单独的「菜单」Drawer 承载次级入口。

## 目标

1. 桌面端顶栏直接显示「同步对账」和「模板」两个按钮。
2. 「更多」下拉中移除这两项，只保留「报表」「记忆」「统计」等次级入口。
3. 移动端菜单补充「同步对账」入口，并保持「模板」入口可用。
4. 不改变同步对账、模板管理、drawer stack、后端 API 的行为。

## 非目标

- 不新增新的页面或路由。
- 不重排报表、记忆、统计等入口。
- 不改 `TelegramSyncButton` 的同步语义。
- 不改 `TemplateDrawer` 的模板 CRUD 行为。

## 设计

### 桌面顶栏

在 `TodoManage.tsx` 的非移动端分支中，将入口顺序调整为：

1. 新建
2. 找回
3. 设置
4. 同步对账
5. 模板
6. 更多

其中「同步对账」直接复用 `<TelegramSyncButton />`，不包在 Dropdown menu item 里。「模板」使用 `Button` + `FileTextOutlined`，点击后执行 `setTemplateDrawerOpen(true)`。

「更多」菜单移除 `telegram`、`template` 和分隔线，只保留：

- 报表
- 记忆
- 统计

### 移动端菜单

移动端仍保留顶栏「菜单」按钮，不把同步和模板做成顶栏常驻按钮。右侧菜单 Drawer 中将「同步对账」放在列表顶部，下面继续保留「找回历史会话」「Prompt 模板」「每日报表」「记忆」「统计」「设置」。

由于 `TelegramSyncButton` 本身渲染的是一个 button，移动端可直接复用；如果它在 `block` 布局中视觉不一致，再用轻量 wrapper 样式约束宽度，不改组件逻辑。

## 风险与对策

- 顶栏按钮增多导致窄桌面换行：当前顶栏已 `flexWrap: 'wrap'`，可接受换行；实现后需要在约 900px 宽度检查不重叠、不裁切。
- `TelegramSyncButton` 从 Dropdown 中移出后事件传播环境变化：组件本身不依赖 Dropdown，上移后应保持预览弹窗行为；用手动点击验证。
- 移动端复用 `TelegramSyncButton` 可能不是整行按钮：如出现宽度不一致，补一个作用域很小的 CSS wrapper。

## 验收标准

1. 桌面端顶栏无需打开「更多」即可看到「同步对账」和「模板」。
2. 桌面端「更多」菜单不再出现「同步对账」和「模板」，仍能打开「报表」「记忆」「统计」。
3. 点击「同步对账」仍先 dry-run 预览；无动作时提示无需动作；有动作时弹出确认 Modal。
4. 点击「模板」打开现有「Prompt 模板库」，模板新增、编辑、复制、删除行为不变。
5. 移动端「菜单」Drawer 内能找到并使用「同步对账」和「Prompt 模板」。
6. `npm run build:web` 或等价前端构建通过。
