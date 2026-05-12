# 待办详情抽屉样式重构 (Todo Detail Drawer Style Refresh)

- 日期：2026-05-12
- 范围：`web/src/TodoManage.tsx` 详情 Drawer（行 2096–2215）+ `web/src/TodoManage.css`
- 后端配套：新增 `GET /api/uploads/file` 用于回显 web-uploads 中的图片

## 1. 背景与问题

当前详情抽屉视觉简陋：

- 描述是裸 `<p>`，里面 `@/Users/.../web-uploads/<file>.png` 直接以文本形式展示，附件无预览
- 元数据用 `<strong>象限：</strong>值` 的纯文本，无 Tag/Badge/图标
- 全部样式以 inline `style={{ ... }}` 写在 JSX 中，难维护、无法响应主题
- 操作按钮（沉淀/Pipeline/编辑/验收）平铺没有主次
- 评论区头部、空态、卡片缺乏视觉层次

用户原话："代办详情的样式优化一下吧，现在的太丑了"。

## 2. 目标

把详情抽屉重构为三段式信息卡片，提升视觉层次和可维护性，并把图片附件渲染成缩略图。

非目标：

- 不引入新 UI 框架/依赖（继续用 AntD + 现有 CSS）
- 不实现完整的 Markdown 渲染（只做"图片识别 + 纯文本"）
- 不改详情之外的页面（列表、编辑表单等保持不变）
- 不改后端数据模型；只新增一个静态读取端点

## 3. 验收标准

- [ ] 描述中匹配到 `@/abs/path.(png|jpe?g|gif|webp)` 的位置自动渲染为缩略图（点击放大预览），其余文本仍正常展示
- [ ] 象限/状态/层级以 AntD `Tag` 展示，颜色与现有 `QUADRANT_CONFIG` 一致
- [ ] 截止日期：到期前显示中性色，过期变红色，无截止显示"无"
- [ ] 工作目录用等宽字体 + 末端"复制"按钮，复制后 `message.success('已复制')`
- [ ] 顶部 extra 操作按钮主次分明：主操作（验收通过 / 编辑）保持 `type="primary"` 或加粗；次操作（沉淀/Pipeline）弱化
- [ ] 评论区：空态使用 AntD `Empty`；非空评论卡有头像占位、用户名/时间、正文；输入框 + 发送按钮一行
- [ ] 详情 Drawer 宽度从 640 → 720
- [ ] 重复规则横幅保持原位（描述上方）但视觉风格统一到新卡片风
- [ ] 所有改动后的样式集中在 `TodoManage.css` 的 `.todo-detail-*` 类下，**JSX 中不留新增 inline style**（已有不相关的 inline 可不动）
- [ ] 移动端窄屏（<480px）：Drawer 变全屏，元数据 2 列自适应单列，按钮 wrap 不溢出
- [ ] 后端：`GET /api/uploads/file?path=<abs>` 只允许命中 `~/.agentquad/web-uploads` 目录下的文件，否则返回 403
- [ ] `npm run -w web build` 通过；既有用例（`test/uploads.route.test.js`、`test/todos.route.test.js`）不回归；新增最小化用例覆盖 uploads file route 的路径合法性校验

## 4. 设计

### 4.1 抽屉骨架

```
┌─ Drawer (width=720) ─────────────────────────────────┐
│ title=todo.title  extra=[验收?, 沉淀, Pipeline, 编辑] │
├──────────────────────────────────────────────────────┤
│ [Section A] 元数据条 (chips)                          │
│   ├ 象限 Tag · 状态 Tag · 层级 Tag                    │
│   ├ 截止: <date | 无 | 过期红字>                      │
│   └ 工作目录: <mono path> [复制]                      │
│                                                       │
│ [Section B] 重复规则横幅（仅 detailRule 存在时）       │
│                                                       │
│ [Section C] 描述卡                                    │
│   ├ 文本块（保留换行）                                 │
│   └ 图片附件网格（自动从描述抽取 @/abs/path.png）       │
│                                                       │
│ [Section D] 评论区                                    │
│   ├ 标题 "评论 (N)"                                   │
│   ├ 输入框 + 发送                                     │
│   └ 评论列表 / Empty                                  │
└──────────────────────────────────────────────────────┘
```

### 4.2 各 Section 详细

**Section A — 元数据条**

- 一个 `.todo-detail-meta` 容器，flex wrap，gap 8px
- 每项 `.todo-detail-meta-chip`：浅灰背景胶囊、内含 label + value
- 象限 Tag 颜色继续走 `QUADRANT_CONFIG[i].color`
- 状态枚举：
  - `done` → 绿色 Tag "已完成"
  - `ai_done` → 蓝色 Tag "AI 完成 · 待验收"
  - 其他 → 默认色 Tag "待办"
- 截止日期：用 dayjs 比较 `now`，过期加 class `.todo-detail-overdue`（红字 + ⚠️ 图标）
- 工作目录：`<code>` 标签 + 末尾 `<CopyOutlined>` 图标按钮

**Section B — 重复规则横幅**

- 保留现有逻辑，只把 inline style 抽到 `.todo-detail-recurring-banner`
- 视觉对齐到 Section A（同样的圆角、border、padding）

**Section C — 描述卡**

- 容器 `.todo-detail-description`：白底/暗底自适应、12px 圆角、1px border
- **解析逻辑**：在 React 渲染时遍历 `description` 文本，用一个 `parseDescription(text)` 函数返回 `Array<{type:'text'|'image', value:string}>`
  - 正则：`/@(\/[^\s@]+?\.(?:png|jpe?g|gif|webp))(?=\s|$|[，。、])/gi`
  - 命中的 `value` 作为 image item；其余文本拼成 text item（保留换行 → `white-space: pre-wrap`）
- 图片项渲染为 AntD `<Image>`（支持点击 zoom），src 走 `/api/uploads/file?path=<encodeURIComponent(abs)>`
- 描述里仍保留路径文字 vs 移除？→ **移除路径文字**，避免重复噪音（只显示缩略图）
- 多张图片以 3 列网格（移动端单列）展示，每张 max-height 160px

**Section D — 评论区**

- `.todo-detail-comments-header` 标题，无折叠
- 输入框沿用现有 `Input.TextArea` + 主按钮，仅样式抽出
- 空态：`<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无评论" />`
- 评论卡 `.todo-detail-comment-card`：
  - 左侧圆形头像占位（用首字母或固定 emoji；当前数据模型无头像字段，先用 ✍️ 图标 + 浅色背景圆）
  - 右上角时间 + 删除按钮（hover 显示）
  - 正文 `white-space: pre-wrap`，保留换行

### 4.3 后端新增端点

`GET /api/uploads/file?path=<abs>`

- 仅允许 path 经 `path.resolve` 后落在 `DEFAULT_UPLOAD_DIR`（`~/.agentquad/web-uploads`）之内，否则 403
- 文件不存在 → 404
- 命中后用 `res.sendFile(abs)`，自动带上 Content-Type
- 单元测试覆盖 3 个 case：合法路径 200、目录穿越 `..` 403、不存在 404

**为何不用 `express.static`：** 现有上传路径返回的是**绝对路径**，前端把绝对路径塞进 description；用静态目录意味着前端要再做一次"abs → web URL"的转换，散落在多处。集中到一个端点更简单，路径校验也更明确。

### 4.4 CSS 命名与作用域

- 全部新增类以 `.todo-detail-` 前缀，集中追加在 `TodoManage.css` 末尾
- 暗色主题：先用 CSS 变量（`--ant-color-bg-container` 等 AntD CSS token）兜底；若项目当前未启用 dark token，先按 light 主题写 hex，标注 TODO（不阻塞验收）
- 移动端断点继续沿用 `mobile.css` 的 `@media (max-width: 480px)` 模式

### 4.5 操作按钮主次

- 验收通过（仅 `ai_done`）：保持 `type="primary"` 绿色
- 编辑：`type="default"`，但提到最右（用户最常用）
- 沉淀到记忆 / 启动 Pipeline：`type="text"` 或 `size="small"` 弱化为次级操作
- 移动端窄屏：次级操作收进一个 `<Dropdown>` 「···」菜单

## 5. 文件清单

| 文件 | 改动类型 | 说明 |
| --- | --- | --- |
| `web/src/TodoManage.tsx` | 改 | 详情 Drawer JSX 重构；新增 `parseDescription`、`renderMetaChips`、`renderCommentCard` 局部辅助函数 |
| `web/src/TodoManage.css` | 改 | 末尾追加 `.todo-detail-*` 样式 |
| `web/src/mobile.css` | 改 | 追加 `.todo-detail-*` 的移动端断点 |
| `src/routes/uploads.js` | 改 | 新增 `router.get('/file', ...)` |
| `test/uploads.route.test.js` | 改 | 新增 3 个用例覆盖新端点 |

## 6. 风险与回滚

- **图片端点路径校验失误** → 用 `path.resolve(uploadDir)` + `startsWith` 双重校验，并加单元测试覆盖目录穿越
- **描述里图片路径正则误判** → 限定后缀白名单 (png/jpe?g/gif/webp)；对边界字符（`@` 后必须跟 `/`）严格匹配
- **暗色主题对比度不足** → 优先 AntD token；如仍有问题在后续小迭代修
- **回滚**：所有改动集中在上列 5 个文件 + 1 个新增端点；revert commit 即可

## 7. 范围外（明确不做）

- Markdown 渲染（链接/粗体/列表）
- 描述编辑器（仍走"编辑"按钮的旧表单）
- 评论头像上传 / 用户系统
- 详情之外其它页面的样式
