# 设置抽屉布局重构 (Settings Drawer Redesign)

- 日期：2026-05-13
- 范围：`web/src/SettingsDrawer.tsx`（单文件 1200+ 行）+ 少量配套 CSS
- 不动：后端 API、表单字段语义、保存逻辑、i18n、Drawer 外侧浮动按钮组

## 1. 背景与问题

当前设置抽屉用户原话："整体上有点乱，布局什么的"。逐项拆解：

- **顶部 Descriptions 表**（版本 + 活跃 AI 会话数）带边框、像表单字段，跟下面真表单争视觉
- **Drawer 宽 560px** 撑 5 个顶 Tab，"Lark / 飞书"这种长 label 比较挤
- **"运行" tab 只有 3 个字段**，跟 Telegram / 价目表那种重型 tab 密度差距大，下方一大片空白
- **"配置文件位置"** 缩在抽屉最底部小字，没作为元信息抽出来
- **服务端口** 用了原生 `<Input type="number">` 全宽，跟价目表里 `InputNumber + 固定宽` 不一致
- **保存按钮在右上角 `extra`**，长表单（Telegram、价目表）滚到底后看不见，容易让人忘了"保存"或误点关闭丢改动

## 2. 目标

把设置抽屉重构为**左侧导航 + 右侧内容**的两栏布局，配底部 sticky 操作栏。提升视觉层次与扫读效率，长表单滚动时保存按钮始终可见。

非目标：

- 不动表单字段、校验规则、保存逻辑、`buildToolPatch` / `handleSave` 实现
- 不做 i18n（保持中文硬编码，等后续统一迁移）
- 不调整 Drawer 外侧浮动按钮组（主题/语言切换在 `main.tsx`）
- 不改后端 `getStatus / getConfig / updateConfig` 等 API
- 不引入新 UI 依赖（继续用 AntD）

## 3. 验收标准

### 功能层面（不回归）
- [ ] 所有原字段读 / 写 / 保存正常：`port` / `defaultTool` / `defaultCwd` / `tools.{claude,codex,cursor}` / `telegram.*` / `lark.*` / `pricing.*` / `dispatch.*`
- [ ] 跨左 nav section 切换不丢未保存输入（继续靠 `form.getFieldsValue(true)`）
- [ ] Telegram「测试」、Lark「测试」、抓 ID Modal、目录选择、重新检测工具、价目表添加 / 删除模型等子交互行为一致
- [ ] 默认工具切换、Dispatch perUser / perChat 覆盖编辑保留
- [ ] 保存失败时 `message.error` 仍能弹出；保存成功后 `message.success` 仍弹出

### 视觉层面
- [ ] 抽屉打开时第一屏不再被 Descriptions 表挤占（该表已删除）
- [ ] 左侧 nav 5 项纵向排列，每项 label 不再被挤压换行
- [ ] 滚动到 Telegram / 价目表底部时，底部 sticky 操作栏（含保存按钮）仍可见
- [ ] 服务端口控件宽度与价目表的 `InputNumber` 视觉一致
- [ ] 在 1440×900 笔记本上，760px 抽屉不与主内容撞色 / 撞边

### 非功能
- [ ] 不引入新 npm 依赖
- [ ] 不破坏正在进行的 i18n 迁移 key 结构（本次保持文案硬编码，文件不引入 `t('...')`）
- [ ] `npm run -w web build` 通过

## 4. 设计

### 4.1 整体骨架

```
┌─ Drawer 760px ─────────────────────────────────────────┐
│ AgentQuad 设置                                     ×   │   ← header 区，无副信息
├──────────────┬─────────────────────────────────────────┤
│ 通用         │                                         │
│ AI 工具      │   右侧内容区（当前 section 表单）       │
│ Telegram     │   可纵向滚动                            │
│ 飞书         │                                         │
│ 价目表       │                                         │
│              │                                         │
│              │                                         │
├──────────────┴─────────────────────────────────────────┤
│ ⚙ ~/.agentquad/config.json           [关闭]  [保存]    │   ← sticky 底栏
└────────────────────────────────────────────────────────┘
```

### 4.2 改动清单

#### 4.2.1 删除
- 顶部 `<Descriptions column={1} bordered size="small">` 整块（版本 + 活跃会话数）
- `getStatus()` 调用 + `status` state 及相关 useState（不再需要）
- Drawer `extra` 里原本的 `<Space><Button>关闭</Button><Button>保存</Button></Space>` → 让 Drawer 用默认右上角 X 关闭
- 最底部 `<Paragraph type="secondary">配置文件位置...</Paragraph>`（移动到底栏左侧）

#### 4.2.2 改造：顶 Tab → 左 Tab
- `<Tabs items={...}>` 加 `tabPosition="left"`，给左 nav 一个固定容器宽度
- AntD Tabs 在 `left` 模式下宽度由 `tabBarStyle` 控制：`tabBarStyle={{ width: 132 }}`（保证 5 项不换行）
- 各项 label 维持原文案：`通用 / AI 工具 / Telegram / 飞书 / 价目表`
  - "运行" → "通用"（与左 nav 心智一致；本次只改 label，不动 key 也行，保持 `key='run'`）
- `activeKey` state 仍保留，但本次**不持久化到 localStorage**（YAGNI）

#### 4.2.3 新增：底部 sticky 操作栏
- 容器：在 `<Drawer>` 内部 form 之外加一个固定底栏，使用 Drawer 的 `footer` prop（AntD 5 支持）
- 结构：
  ```tsx
  footer={
    <div className="settings-footer">
      <Text code className="settings-footer-path">~/.agentquad/config.json</Text>
      <Space>
        <Button onClick={onClose}>关闭</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
      </Space>
    </div>
  }
  ```
- 配套 CSS：新建 `web/src/SettingsDrawer.css`（与 `TodoManage.css` / `WikiDrawer.css` 同模式），在 `SettingsDrawer.tsx` 顶部 `import './SettingsDrawer.css'`：
  ```css
  .settings-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .settings-footer-path {
    font-size: 12px;
    color: var(--text-secondary);
    user-select: all;  /* 单击全选方便复制 */
  }
  ```
- 路径点击行为：用 `user-select: all` 让单击直接全选文本（不引入 Clipboard API，避免新依赖逻辑），后续要复制按钮可加

#### 4.2.4 "通用" tab 内分组
内部加两个轻量小标题，跟价目表 tab 已有的 `<Paragraph><Text>默认费率（fallback）</Text></Paragraph>` 模式一致，用加粗文本不用 `<Title>`，避免抢视觉：

```
启动
  默认启动目录
  终端链接打开编辑器

服务
  服务端口
```

服务端口控件：`<Input type="number" min={1} max={65535} />` → `<InputNumber min={1} max={65535} style={{ width: 160 }} />`（统一为价目表风格）

#### 4.2.5 其他 tab 不动
- AI 工具 / Telegram / 飞书 / 价目表 tab 内部组件结构、Collapse、Form.List、字段顺序保持原样
- 仅因 Drawer 宽度从 560 → 760，所有 tab 内部的输入控件会自然获得更多横向空间，不需要逐个调宽度

### 4.3 受影响的代码位置

| 位置 | 改动 |
|------|------|
| `SettingsDrawer.tsx:99` | 删除 `status` state |
| `SettingsDrawer.tsx:164-167` | 移除 `getStatus()`，只保留 `getConfig()` 调用 |
| `SettingsDrawer.tsx:496-537` | "运行" tab 内部加分组小标题；服务端口换 `InputNumber` |
| `SettingsDrawer.tsx:1162-1173` | Drawer：宽度 560→760，移除 `extra`，新增 `footer` |
| `SettingsDrawer.tsx:1176-1179` | 删除 `<Descriptions>` 块 |
| `SettingsDrawer.tsx:1182-1192` | `<Tabs>` 加 `tabPosition="left"` + `tabBarStyle` |
| `SettingsDrawer.tsx:1207-1209` | 删除底部 `<Paragraph>` 配置文件位置（已移至 footer） |
| `web/src/SettingsDrawer.css` | 新建文件，定义 `.settings-footer / .settings-footer-path / .settings-section-title` 样式 |

### 4.4 风险与缓解

| 风险 | 缓解 |
|------|------|
| AntD `Tabs tabPosition="left"` 与 Form `layout="vertical"` 组合下右侧内容区可能不滚动 | 在 Tabs 外层包裹 `<div style={{ overflowY: 'auto' }}>` 或依赖 Drawer body 自身的滚动（默认就有）。需要本地起 dev server 验证 |
| Drawer 加了 `footer` 后内容区被压缩，长表单滚动正常但顶部内边距可能错位 | 用 AntD 内置 footer prop（不自造 absolute 定位），让 AntD 自己处理 layout |
| 760px 在 13" 屏（1440 宽）抽屉占主屏 ~53%，可能压缩主内容 | 用户已接受 760px 决策。若实际过宽，下次迭代再加"折叠"按钮 |
| `status` state 删除后 `tokenSource / larkSecretSource` 等仍依赖 `getConfig()` 的返回，无受影响 | 验证 `useEffect` 只移除 `getStatus` 那一支，不动其他读取 |
| 移除右上角 `extra` 按钮后，习惯点右上角"保存"的肌肉记忆失效 | 用户已确认底部 sticky 即可，不保留双份 |

### 4.5 测试 / 验证手段

- 本地起 `npm run -w web dev` + 后端，打开设置抽屉
- 手动 checklist：
  - 切换 5 个 nav section，确认右侧内容切换正确
  - 改一个字段（如默认启动目录），切到其他 section 再切回，输入仍在
  - 在 Telegram tab 滚到最底，确认保存按钮仍可见
  - 点保存 → 成功提示 / 错误提示
  - 改服务端口 → 保存 → 重新打开抽屉值仍正确
  - 1440×900 与 1920×1080 两个视窗下视觉无明显问题
- `npm run -w web build` 通过

## 5. 不在本次范围

- Drawer 外侧浮动按钮组（主题 / 语言切换）的位置 / 视觉
- 文案 i18n 化（等后续 i18n 统一迁移）
- 各 tab 内部表单结构优化（如 Telegram 改用 Card 替换 Collapse）—— 留待方案 C 做后续迭代
- localStorage 持久化选中 section
- 配置文件路径"一键复制"按钮（先靠 `user-select: all` 单击全选）

## 6. 后续可能的迭代（不属于本次）

- 给配置文件路径加复制按钮 + `message.success('已复制')`
- 给每个 tab 顶部加 1 行 section 简介（"管理 AI 工具的命令与路径"）
- 各 tab 内用 Card 替代 Collapse（方案 C 的延伸）
- 抽屉宽度响应窗口宽度（窄屏自适应 100%）
