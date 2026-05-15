# History item — live info badge

**Date**: 2026-05-15
**Status**: Draft
**Owner**: lzh

## 问题陈述

主列表中已展开的会话历史条目（`.todo-history-item`），当子会话处于 `ai_running` / `ai_pending` / idle 时，头行只显示「Claude Code / 启动时间 / ✦运行中」徽标，到右侧「本地继续」按钮之间留出一大段空白。

主人反馈这块空白「值得展示更多信息」，最常想知道的是：

- 这家伙到底还在不在动？有没有卡住？（运行中）
- 它在问我什么？我得点进 focus 才知道。（待确认）
- 上次它干完活是多久之前？（idle）

## 范围

**仅影响** `web/src/components/TodoCard/TodoCard.tsx` 中渲染的 `.todo-history-item` 头行（截图所在位置）。

`SessionFocus` 全屏视图没有复用这套卡片（已确认），因此不涉及窄宽度 / dock 场景。

**仅在以下三种态**渲染额外信息：

| 态 | 展示内容 |
|---|---|
| `ai_running`（由 `deriveAiState` 输出 `running`） | 迷你折线图 + 「活跃 N 秒前」文字 |
| `ai_pending`（由 `deriveAiState` 输出 `pending`） | ⚠ icon + 权限文本预览（首行截断）+ 「等待 N 时」 |
| `idle`（且 `liveSession` 存在） | 「上次活跃 N 前」文字 |
| 其他（`done` / `failed` / `stopped` / 历史归档会话） | **不变**，像素级一致 |

## 数据源（全部已存在，不新增 API）

| 字段 | 来源 | 用途 |
|---|---|---|
| `liveSession.lastOutputAt` | `aiSessionStore`，每 3s poll 刷新 | 运行中「活跃 N 秒前」 |
| `liveSession.lastTurnDoneAt` | 同上 | idle「上次活跃 N 前」 |
| `liveSession.startedAt` | 同上 | idle fallback（lastTurnDoneAt 缺失时） |
| `liveSession.permissionPrompt.text` | PTY WS 即推 + 3s poll 兜底 | 待确认权限文本预览 |
| `liveSession.permissionPrompt.createdAt` | 同上 | 待确认「等待 N 时」 |
| `outputRates.get(sessionId)` | 前端 5s 滑动窗口采样 | 折线图渲染 |

## UI 规格

### 运行中（running）

在 `.todo-history-headline` 中现有 `<span className="todo-ai-state ...">` 徽标之后、`.todo-history-resumed` 之前插入：

```tsx
<span className="todo-history-live todo-history-live--running">
  <ActivitySparkline sessionId={session.sessionId} width={56} height={14} />
  <span className="todo-history-live-text">{t('todo:card.liveActive', { ago: '8s' })}</span>
</span>
```

- 折线图尺寸 56×14，颜色继承父元素 `color`（用 `currentColor`），父元素颜色 = `var(--ai-running)`。
- 「活跃 8s 前」文字 size 11px、color `var(--text-tertiary)`。
- `lastOutputAt` 缺失时仅显示折线图，不显示文字（兜底，避免 NaN 秒前）。

### 待确认（pending）

替换上面的 wrapper：

```tsx
<button
  type="button"
  className="todo-history-live todo-history-live--pending"
  onClick={(e) => {
    e.stopPropagation()
    useDispatchStore.getState().openFocus(todo.id, session.sessionId)
  }}
  title={prompt.text /* 全文 */}
>
  <AlertTriangle size={12} aria-hidden />
  <span className="todo-history-live-text">{truncatePromptText(prompt.text)}</span>
  <span className="todo-history-live-meta">{t('todo:card.liveWaiting', { ago: '1m' })}</span>
</button>
```

- 文字截断：取 `prompt.text` 首行（按 `\n` split[0]），再用纯字符长度 ≤ 40，超出加 `…`。中英文都用字符计数（`Array.from(str).slice(0, 40)`）。
- 整个 wrapper 是按钮，点击 stopPropagation + 打开 focus 跳转。键盘可达（Tab focus + Enter）。
- 颜色：图标与文字用 `var(--ai-pending)`（项目里走 amber/yellow 系），meta 文字 `var(--text-tertiary)`。
- `prompt.text` 为空时仅显示图标 + 「等待 N 时」。

### idle

```tsx
<span className="todo-history-live todo-history-live--idle">
  <span className="todo-history-live-text">{t('todo:card.liveLastActive', { ago: '5m' })}</span>
</span>
```

- 仅在 `liveSession` 存在（即 idle 但 session 还在内存里）时渲染。归档 / 重启服务后已 detach 的 idle 不渲染——与现有 `sessionState !== 'idle' || liveSession` 渲染门控口径一致。
- 时间源：`lastTurnDoneAt || startedAt`。
- 文字 size 11px、color `var(--text-tertiary)`。

## 时间格式化

新增工具函数 `formatRelativeShort(ms)` 放在 `web/src/utils/time.ts`（如果不存在就新建）：

| 时长 | 输出 |
|---|---|
| `< 5s` | `刚刚` / `just now` |
| `< 60s` | `Ns` / `Ns ago` |
| `< 60min` | `Nm` / `Nm ago` |
| `< 24h` | `Nh` / `Nh ago` |
| `≥ 24h` | `Nd` / `Nd ago` |

注意：i18n key 不返回单位，由 i18n 模板组合。模板形如 `活跃 {{ago}} 前` / `Active {{ago}} ago`。

刷新策略：**不加 setInterval**。组件随父 `TodoCard` 重渲染时重新计算（父跟 `aiSessionStore` 订阅，3s poll 会触发 re-render）。`ActivitySparkline` 自身已有 1Hz tick，独立运转。

## i18n 新增 key（zh-CN + en-US）

```ts
// todo.card.*
liveActive: '活跃 {{ago}} 前'           // 'Active {{ago}} ago'
liveWaiting: '等待 {{ago}}'              // 'Waiting {{ago}}'
liveLastActive: '上次活跃 {{ago}} 前'    // 'Last active {{ago}} ago'
liveRelativeJustNow: '刚刚'              // 'just now'
liveRelativeSec: '{{n}}s'                // 同
liveRelativeMin: '{{n}}m'
liveRelativeHour: '{{n}}h'
liveRelativeDay: '{{n}}d'
```

## CSS 新增

放在 `web/src/TodoManage.css` 中 `.todo-history-headline` 块附近：

```css
.todo-history-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  min-width: 0;
  max-width: 320px;
  white-space: nowrap;
  overflow: hidden;
}

.todo-history-live--running { color: var(--ai-running); }
.todo-history-live--pending {
  color: var(--ai-pending);
  border: 0;
  background: transparent;
  cursor: pointer;
  padding: 0;
}
.todo-history-live--pending:hover .todo-history-live-text { text-decoration: underline; }

.todo-history-live-text {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.todo-history-live-meta {
  color: var(--text-tertiary);
  flex-shrink: 0;
}
```

## 边界条件

1. **`lastOutputAt` 在未来**（服务时钟漂移）：`now - lastOutputAt < 0` 时按 0 处理（输出「刚刚」）。
2. **`permissionPrompt` 为空但 status 是 `pending_confirm`**：可能发生在 PTY 提取失败 → 只显示 ⚠ + 等待时长，不显示文本。
3. **`liveSession` 不存在的 idle 会话**：不渲染 live 行，沿用现状（不出现 `todo-ai-state` 徽标）。
4. **折线图全 0（运行中但 PTY 安静）**：`ActivitySparkline` 已经有 `isIdle` 中线兜底，不会渲染空 SVG。
5. **窄宽度**：`max-width: 320px` 防止权限文本撑爆头行；`flex-wrap` 已在 `.todo-history-headline` 上，超出会优雅换行。

## 验收标准

- ✅ `ai_running` 会话头行显示折线图 + 「活跃 N 秒前」，折线图随实时输出脉动；
- ✅ `pending_confirm` 会话头行显示 ⚠ + 权限文本预览 + 等待时长，点击进入 focus 视图的 PermissionCard；
- ✅ idle（且 live）会话头行显示 「上次活跃 N 前」；
- ✅ 终态（done / failed / stopped）和已归档 idle 卡片渲染**像素级与改前一致**；
- ✅ 信息随 3s 后端 poll 自动刷新，无需额外定时器；
- ✅ 中英文都正确显示，时间单位本地化；
- ✅ Dark / light 主题色彩对比度满足设计 token 规范；
- ✅ 无新增网络请求 / 数据库字段；
- ✅ 不破坏 `.todo-history-headline` 现有的 `flex-wrap` 行为，超长不撑高单行。

## 不做的事（YAGNI）

- ❌ 不放快速「同意/拒绝」按钮（避免误点，已有 PermissionCard 处理）
- ❌ 不展示 token 使用量、模型名、cwd、CPU%（这些有别的入口，列表里加只会变噪音）
- ❌ 不加每秒滚动的实时秒针（3s poll 已经够；折线图自己有 1Hz）
- ❌ 不影响 SessionFocus / dock（这个项目里不存在该场景）
- ❌ 不调整 idle 显示门控（仍然只在 `liveSession` 存在时渲染，与现有徽标一致）

## 风险

| 风险 | 缓解 |
|---|---|
| 头行 `flex-wrap` 在窄宽度下把 live 行挤到第二行，撑高卡片 | 给 `.todo-history-live` 加 `max-width: 320px` + ellipsis；预期被挤到第二行时不撑得太宽 |
| 多个 running session 同时挂 1Hz `setInterval`（ActivitySparkline 内部） | 这是 ActivitySparkline 既有设计，本 spec 不引入新 timer |
| `permissionPrompt.text` 含敏感命令（如 token）暴露在列表 | 列表本身就是登录用户自己看，不算泄露；但 tooltip 全文展示要保留 stopPropagation 避免点击穿透到背后的卡片打开操作 |
