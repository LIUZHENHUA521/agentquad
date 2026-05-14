# README 改造设计文档

> 2026-05-14 · 目标：把 README 改造成能拉到 GitHub global star 的版本

## 背景

- 项目 AgentQuad（原 quadtodo）当前 README 长 318 行，几乎全中文，没 badges、没 hero 截图/GIF。
- GitHub 仓库 `LIUZHENHUA521/quadtodo` 名字未跟 npm 包名 `agentquad` 同步。
- 现 README 底部 254-318 行混入「请完成以下待办任务: 后续工作 ...」60 行脏内容，是历史会话误写入。
- 三大差异化卖点（MCP / Telegram / OpenClaw）被埋在中段，第一屏看不到。
- 老用户迁移段（22-33 行）占首屏黄金位。

## 目标

1. 双语 README：英文为主（GitHub trending 走全球分发），中文 fallback（照顾中文圈）。
2. 首屏 30 行内传达：是什么、谁该用、3 个核心卖点、quickstart。
3. 至少 4 张实拍截图 + 1 张 demo GIF 作为 hero。
4. 所有过期 / 脏内容清理干净。
5. 仓库名 / 包名一致（GitHub repo 改名为 agentquad）。

## 非目标

- 不重写 `docs/MCP.md` / `docs/TELEGRAM.md` / `docs/OPENCLAW.md` / `docs/MOBILE.md` 等深度文档。README 只做指引。
- 不做 logo 设计（沿用纯文字标题）。
- 不做网站 / landing page。
- 不动 CLI 文案 / 内部代码注释。

## 产出文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `README.md` | 重写 | 英文主入口 |
| `README.zh-CN.md` | 新建 | 中文版本，结构对齐 |
| `assets/hero-demo.gif` | 新建 | 10-15s 流程演示，< 4MB |
| `assets/screenshots/board.png` | 新建 | 四象限主看板 |
| `assets/screenshots/ai-terminal.png` | 新建 | 内嵌 AI 终端 |
| `assets/screenshots/stats.png` | 新建 | 统计抽屉 |
| `assets/screenshots/cmdk.png` | 新建 | ⌘K / MCP 面板 |

## README 结构（英中对齐）

### 1. Hero（≤ 25 行）

- H1 项目名：`AgentQuad`
- Tagline（英）：`Four-quadrant todo board where every task spawns a local Claude / Codex session. Local-first, MCP-ready, Telegram-friendly.`
- Tagline（中）：「四象限待办看板，每条 todo 都能起一个本地 Claude / Codex 会话。全本地存储，原生支持 MCP，能从 Telegram 远程驱动。」
- 语言切换：`English` | `简体中文`（互链）
- Badges（一行）：
  - npm version → `https://img.shields.io/npm/v/agentquad`
  - downloads → `https://img.shields.io/npm/dm/agentquad`
  - license MIT
  - node `>=20`
  - platform `macOS | Linux`
- Hero GIF：`assets/hero-demo.gif`

### 2. What & Why（≤ 15 行）

- 1 句话价值主张
- 3 条 bullet：
  - vs Linear / Todoist —— 它们没法在卡片里直接跑 Claude / Codex 终端
  - vs Cursor / Aider —— 它们没有任务管理 / 跨项目调度
  - vs raw Claude Code —— 没有可视化看板和会话历史浏览

### 3. Screenshot grid（2x2）

四张图（board / ai-terminal / stats / cmdk），每张配一句话标题。

### 4. Quickstart

```bash
npm install -g agentquad
agentquad                 # opens http://127.0.0.1:5677
```

补一句首跑向导和环境要求。

### 5. Features（bullet list，每条 1 行）

- Eisenhower quadrant board with drag-and-drop
- Per-todo Claude / Codex terminal sessions
- Session logs persisted locally, searchable
- Weekly / monthly stats with token cost estimation
- Local-first SQLite + filesystem，no cloud lock-in
- Cross-platform: macOS + Linux

### 6. Integrations（差异化卖点单独成节）

每个集成一段（3-5 行 + 一条命令 + 链接到深度文档）：

- **MCP server**（17 个工具）→ `docs/MCP.md`
- **Telegram bot**（每 task 一个 forum topic）→ `docs/TELEGRAM.md`
- **OpenClaw**（微信桥接）→ `docs/OPENCLAW.md`
- **Mobile access**（Tailscale 私网）→ `docs/MOBILE.md`

### 7. Configuration

保留现 README 140-165 行内容，瘦身 30%。

### 8. Commands

保留现 README 命令表，删除冗余说明。

### 9. Architecture（折叠 `<details>`）

保留现 README 217-239 行目录树，包在 `<details>` 里不挤首屏。

### 10. Troubleshooting

- 保留：端口占用、`claude` 找不到、`node-pty` 安装、`session_not_found`、终端排版
- 删除：Multi-agent Pipeline 已移除（已是过去时）、0.3.0 升级提示（过期）

### 11. License + CTA

MIT · `⭐ Star us on GitHub if you find this useful!` · 贡献指南 1 行

## 删除清单（现 README）

- 第 5 行「原名 quadtodo」附注 → 移到 README 末尾「Project history」一行脚注，正文不再出现
- 第 7 行 GitHub 链接 → 改为 `agentquad`
- **第 22-33 行**「从 quadtodo 升级」整段
- 第 250-251 行 Multi-agent Pipeline / 0.3.0 升级提示
- **第 254-318 行**脏 todo 内容

## 截图采集流程（Playwright MCP）

1. 确认 `http://127.0.0.1:5677` 服务可达（已确认 ✓）
2. 浏览器打开主页 → 调成合适窗口尺寸（1440×900 或 1280×800）
3. 按顺序截图：
   - 主看板：`assets/screenshots/board.png`
   - 点开某个 todo → 启动 AI 终端 → 等 Claude 输出几行 → 截图 `ai-terminal.png`
   - 点顶栏 📊 → 截图 `stats.png`
   - 按 ⌘K → 截图 `cmdk.png`
4. 数据敏感词处理：如果当前 todo 列表有不便展示的内容，先建 2-3 条 demo todo（如「Refactor login flow」「Fix payment bug」），让截图整洁。
5. 截图原图保留在 `assets/screenshots/`（不压缩，给 README 渲染时浏览器自己缩放）。

## GIF 录制流程

1. macOS `Cmd+Shift+5` → 录制选定区域，覆盖浏览器 viewport
2. 演示路径（10-15s）：
   - 点击「新建 todo」→ 输入标题 → 拖到象限 1
   - 点开 todo → 点「启动 AI 终端」→ Claude 跑两行命令
   - 关闭 todo → 看板回到全局
3. 输出 `.mov` → `ffmpeg` 转 `.gif` 或 `.webp`：
   ```bash
   ffmpeg -i demo.mov -vf "fps=15,scale=1200:-1:flags=lanczos" -loop 0 hero-demo.gif
   ```
4. 目标文件大小 < 4MB（GitHub 推荐 < 10MB，越小加载越快）
5. 放在 `assets/hero-demo.gif`

## 仓库改名收尾

- GitHub repo 改名（用户在 web 上操作，不在本任务范围）
- README 所有链接里 `quadtodo` → `agentquad`
- 完成后用户手动跑：
  ```bash
  git remote set-url origin git@github.com:LIUZHENHUA521/agentquad.git
  ```

## 验收标准

1. `README.md` 首屏（前 30 行）包含：title / tagline / badges / language switch / hero GIF
2. 一个不懂中文的开发者能 5 秒看懂这是什么
3. 三大集成（MCP / Telegram / OpenClaw）在前半部分被明确推介
4. 所有过期 / 脏内容删除（第 22-33、250-251、254-318 行）
5. 双语 README 信息对齐，没有一边漏掉的章节
6. GitHub 上预览渲染正常（用 Playwright 打开 raw GitHub view 或 PR diff 检查）
7. 包含 ≥ 4 张实拍截图 + 1 张 GIF，所有图都能正确渲染
8. 仓库改名（用户后做）后所有链接仍可访问
9. `npm install -g agentquad` 这条命令仍可用（不影响 npm 包，纯文档变更）

## 风险 & 回滚

- 风险：截图里出现敏感 todo 数据 → 先建 demo todo + 隐藏真实数据
- 风险：GIF 文件过大拖慢 GitHub 加载 → 强制限制 < 4MB
- 回滚：纯文档变更，直接 `git revert` 即可

## 实施顺序（草案，writing-plans 阶段细化）

1. 用 Playwright MCP 采截图（4 张 PNG）
2. 录 GIF（macOS 屏幕录制 → ffmpeg）
3. 写英文 `README.md`
4. 写中文 `README.zh-CN.md`
5. 把旧 README 整体 diff 一次，确认所有必要信息都迁移
6. 用 Playwright 打开本地 GitHub 渲染（或临时 push branch 后查 raw view）确认渲染 OK
7. 提交 + push（per memory feedback：commit 后立即 push origin main）
8. 提醒用户去 GitHub web 改 repo 名 + `git remote set-url`
