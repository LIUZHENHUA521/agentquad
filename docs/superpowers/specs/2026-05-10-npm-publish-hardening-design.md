# npm publish 发布加固设计

> 状态：Draft（待 spec review + 用户确认）
> 日期：2026-05-10
> 涉及：`package.json`、`src/cli.js`、`src/server.js`、`README.md`、`docs/RELEASE.md`

## 1. 背景与目标

quadtodo 计划发布到 npm registry。当前 `package.json` 已具备发布的基础结构（`bin`/`files`/`prepack`/`engines`），但若现在直接 `npm publish`，新用户在「装了 Node 20 即可一键运行」这件事上仍有 ~30% 的概率失败，主要踩点：

1. `node-pty@1.0.0` 是 2023 年的老版本，对 Node 22+ 没有 prebuild，触发本地 C++ 编译；用户没装 Xcode CLT / build-essential 会直接挂掉。
2. AI 终端核心功能依赖外部 `claude` / `codex` CLI 在 PATH 中，目前只在 README 文字提示，缺失时报 ENOENT，体验差。
3. `prepack` 直接 `cd web && npm run build`，若发布者忘了在 `web/` 下 `npm install`，会发出空的 `dist-web/`。
4. doctor 命令现有检查项不全，无法准确告诉用户"哪里坏了、怎么修"。
5. README 没有"30 秒上手"块，新用户找不到最短路径。

**目标**：完成一轮"发布加固"，让满足 `Node ≥20` + `macOS / Linux` 的用户走 `npm i -g quadtodo && quadtodo doctor && quadtodo start` 三步**真的能跑起来**，缺失的依赖（claude/codex）能被引导自动安装。

**非目标**：
- Windows 支持（暂不做，README 标"暂不支持，规划中"）
- Docker 镜像 / Homebrew tap（C 方案的工作）
- Telegram / Lark / OpenClaw / MCP 的安装向导（这些是 opt-in 高级功能，doctor 提一句就够）
- 跨平台抽象层、nvm/volta 路径自动嗅探（脆弱，留给文档）

## 2. 关键决策（已与用户确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 总方向 | B 方案（发布加固） | 介于"直接发"和"容器化"之间，性价比最高 |
| 平台 | macOS / Linux only | Windows 测试成本高，先放后面 |
| Node 版本 | `>=20` | Node 18 已 EOL（2025-04-30），20 是 active LTS |
| `node-pty` 升级 | `1.0.0` → `^1.1.0-beta22` | 覆盖 Node 22/24 prebuild；API 完全兼容 |
| 内置安装脚本 | 轻 + 中 组合 | doctor 询问 + 独立 `install-tools` 命令，不做"首次启动向导"防误弹 |

## 3. 设计

### 3.1 `package.json` 修改

```jsonc
{
  "engines": {
    "node": ">=20"
  },
  "os": ["darwin", "linux"],
  "dependencies": {
    "node-pty": "^1.1.0-beta22"
  },
  "scripts": {
    "ensure-web-deps": "node scripts/ensure-web-deps.js",
    "build:web": "cd web && npm run build",
    "prepack": "npm run ensure-web-deps && npm run build:web"
  }
}
```

- 新增 `os` 字段：在 Windows 上 `npm install` 时给 EBADPLATFORM 警告（不强制阻止；npm 9+ 行为）。
- `prepack` 拆成两步：先 `ensure-web-deps`（如果 `web/node_modules` 不存在则跑 `cd web && npm ci`），再 build。

新增脚本 `scripts/ensure-web-deps.js`（10 行内）：
- 检查 `web/node_modules` 存在；不在 → spawn `npm ci` in `web/`；输出"installing web deps for prepack..."提示。

### 3.2 `src/cli.js` — `doctor` 扩展

现有 `doctorReport()` 加 5 项硬检查，每项返回 `{ name, ok, message, fix }`：

| 检查项 | 通过条件 | 失败时 fix 文案 |
|---|---|---|
| Node 版本 | `process.version >= 20` | "升级到 Node 20+：`nvm install 20`" |
| `claude` 在 PATH | `which claude` 退码为 0 | "运行 `quadtodo install-tools --claude`" |
| `codex` 在 PATH | `which codex` 退码为 0 | "运行 `quadtodo install-tools --codex`" |
| 前端资源 | `dist-web/index.html` 存在 | "重装：`npm i -g quadtodo`" |
| `node-pty` 可用 | 能 `import node-pty` 且 `spawn('echo', ['ok'])` 收到输出 | "运行 `npm rebuild -g node-pty`" |

`better-sqlite3` 检查：尝试 open + close `~/.quadtodo/data.db`，捕获异常。

doctor 输出末尾，若 claude/codex 缺失：
```
缺失：claude, codex
按 [Enter] 自动运行 `quadtodo install-tools --all`，按 [q] 跳过：
```
通过 `readline` 接收输入；非 TTY 环境（如 CI）跳过询问，只打印命令。

### 3.3 `src/cli.js` — 新增 `install-tools` 子命令

```
quadtodo install-tools [--claude] [--codex] [--all] [-y]
```

- 包名映射：`claude` → `@anthropic-ai/claude-code`，`codex` → `@openai/codex`（启动时已知；硬编码在 cli.js 顶部一个常量里）
- 行为：依次 `spawn('npm', ['install', '-g', pkg], { stdio: 'inherit' })`；任一失败则中断剩余并退码 1
- `-y` 跳过确认；否则先打印 `即将执行：npm install -g <pkg>，继续？[y/N]`
- 失败提示：若退码非 0 且 stderr 含 `EACCES`，提示用户用 `sudo` 或换 nvm
- 兼容：默认无参数 = `--all`

### 3.4 `src/server.js` 启动兜底

- 启动时同步检查 `dist-web/index.html` 存在；不存在则 `console.error` + `process.exit(1)`，错误信息：
  ```
  ❌ 前端资源缺失：dist-web/index.html
     如果你是从源码运行：cd web && npm install && npm run build
     如果你是 npm 安装的：npm i -g quadtodo  # 重装
  ```
- AI 终端 WebSocket 路由（`src/routes/ai-terminal.js`）：spawn 前检查工具是否存在，缺失时发结构化错误帧给前端：
  ```json
  { "type": "tool_missing", "tool": "claude", "fix": "quadtodo install-tools --claude" }
  ```
- `web/src/AiTerminalMini.tsx`：收到 `tool_missing` → 渲染一张提示卡片，显示"运行 `quadtodo install-tools --<tool>`"，附"复制命令"按钮。**不**要黑乎乎报 ENOENT。

### 3.5 `README.md` 修改

- 标题下方插入"30 秒上手"块（在「依赖」段之前）：
  ```markdown
  ## 30 秒上手

  ```bash
  npm install -g quadtodo
  quadtodo install-tools --all   # 装 claude / codex
  quadtodo doctor                # 自检
  quadtodo start                 # 浏览器自动打开 http://127.0.0.1:5677
  ```
  ```
- 「依赖」段：明确 macOS / Linux only，"Windows 暂不支持，规划中"
- 把"必装 claude/codex"放到醒目位置，配 `install-tools` 命令引导

### 3.6 `docs/RELEASE.md`（新建）

发布前手动 / 半自动 smoke test 清单：

```markdown
# Release smoke test

## 准备
- 切到干净分支，确认 web/node_modules 已装

## Pack
- [ ] `npm pack`，记录 tgz 大小（基线 < 5MB）
- [ ] `tar tf quadtodo-*.tgz | grep -E 'src/cli.js|dist-web/index.html|package.json'` 全 hit

## Install
- [ ] 干净目录 `mkdir /tmp/qt-test && cd /tmp/qt-test`
- [ ] `npm i ./path/to/quadtodo-*.tgz` 无 error / 无 native 编译
- [ ] Node 20 + Node 22 各跑一遍

## Run
- [ ] `quadtodo doctor` 全绿（claude/codex 缺也能给修复指引）
- [ ] `quadtodo install-tools --all -y` 能拉到 claude / codex
- [ ] `quadtodo start`，浏览器看板能开
- [ ] 创建 1 个 todo，开 AI 终端，输入 `pwd`，收到响应

## Publish
- [ ] `npm publish --dry-run` 列表确认
- [ ] `npm publish`
- [ ] `npm view quadtodo version` 确认
```

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `node-pty@1.1.0-beta` 是 beta，可能有未知 bug | smoke test 里强制开终端 + resize + 关闭；保留 1.0.0 作为快速回退点（git revert package.json） |
| 用户用 nvm/volta，全局 npm 路径在用户目录，但仍可能 EACCES | `install-tools` 失败时输出 sudo / nvm 提示；不自动加 sudo |
| `npm i -g quadtodo` 这步依然要靠 better-sqlite3 + node-pty 两家 prebuild 服务可达 | 可接受；离线/受限环境本来就不在目标场景 |
| 自动运行 `npm install -g` 的侵入性 | 必须 stdin 确认；CI 环境检测到非 TTY 自动跳过；命令显式打印 |
| 我没法在 Linux 实测 | 用 `docker run -it node:20-alpine` 跑一遍 install + doctor；不要求测 GUI |

## 5. 验收标准

- [ ] 干净 macOS Node 20 / Node 22：`npm i -g quadtodo` 无编译错误，无 warning（`os` warning 只在 Windows 出现）
- [ ] 干净 Ubuntu container Node 20：同上
- [ ] `quadtodo doctor` 5 项检查全部能准确反映状态，每项失败都给 `fix` 命令
- [ ] `quadtodo install-tools --all -y` 能装上 claude / codex；非 `-y` 模式有确认提示
- [ ] `quadtodo start`：dist-web 缺失时给清晰错误；前端缺 claude 时显示提示卡片而非 ENOENT
- [ ] `npm pack` tgz 体积 < 5MB（后端） + 前端构建产物
- [ ] README 顶部"30 秒上手"块成立
- [ ] `docs/RELEASE.md` 清单写完，发布流程可复现

## 6. 工作量估计

约半天到 1 天：
- node-pty 升级 + smoke test：2-3 小时
- doctor / install-tools 实现：2-3 小时
- 前端 `tool_missing` 提示卡片：1 小时
- README + RELEASE.md：1 小时
- 整体回归 + Linux container 测试：1-2 小时
