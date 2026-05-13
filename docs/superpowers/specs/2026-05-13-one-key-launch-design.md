# 一键启动 + 首跑向导 + 发包卫生 设计

> 状态：Draft（待 spec review + 用户确认）
> 日期：2026-05-13
> 涉及：`src/cli.js`、`src/server.js`、`README.md`、`package.json`、`docs/RELEASE.md`
> 关联前置 spec：`2026-05-10-npm-publish-hardening-design.md`（已落地大部分发包加固）

## 1. 背景与目标

`agentquad` (前身 `quadtodo`) 已经具备 npm 发布所需的基础设施（`bin`、`files`、`prepack`、`engines`、`os`），且 `install-tools` / `doctor` 命令也已存在。但用户从 `npm install -g` 到"真正用上"还差 **三步**：

```
agentquad install-tools --all
agentquad doctor
agentquad start
```

且 `agentquad`（不带任何子命令）目前会打印 commander 帮助 —— 这是"一键启动"体感上最大的缺口。

**目标**：把"装完即启"压成 **真正的一步**：

```
npm install -g agentquad && agentquad
```

满足条件的 macOS / Linux + Node 20+ 用户，敲完上面这一行就能看到浏览器里的四象限看板。

**非目标**：
- Windows 支持
- npm postinstall 阶段自动起服务（违反 npm 包礼仪，已在 brainstorm 否决）
- 改动现有 `start` / `stop` / `status` / `doctor` / `install-tools` 子命令的语义
- Telegram / OpenClaw / MCP / Lark 这些 opt-in 集成的安装逻辑

## 2. 关键决策（已与用户确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 一键级别 | L1 默认子命令 + L2 首跑向导 | L1 是基础体验，L2 把首次缺工具的尴尬接住 |
| 端口被占用 | 自动 +1 重试一次 | 用户体感顺滑 > 严格端口控制 |
| README 升级 | "30 秒上手"压成两行 | 同步消除信息差 |
| 发包卫生 | 一并做 | 清理旧 tgz + `npm pack` dry-run 走通 |
| postinstall 自启 | 不做 | 违反 npm 包礼仪、CI 会卡死 |

## 3. 设计

### 3.1 `src/cli.js` — 给 `program` 加默认 action（L1）

#### 改动点

`program` 主对象在所有子命令注册之后、`program.parseAsync()` 之前，挂一个默认 action：

```js
program
  .action(async (cmdOpts, command) => {
    // 用户裸跑 `agentquad`（无子命令、无参数）→ 走 start 的核心逻辑
    await runStart({ /* 默认配置 */ })
  })
```

实现细节：
- 把现有 `program.command('start')` 内的 action 体抽成 `async function runStart(opts)`，让默认 action 和显式 `start` 都复用它
- `runStart` 接收的 opts 与现有 `start` 子命令选项同名（`port` / `host` / `expose` / `noOpen` / `cwd`），但默认 action 调用时全部走 config 默认值
- **保留** `agentquad --help` / `agentquad -V` 正常显示，commander 默认 action 不会吞掉这两个
- 任何子命令（`start` / `stop` / `status` / `doctor` / …）显式存在时，默认 action **不**触发

#### Pid 兜底

默认 action 内部第一步：调用 `isAlive(readPid())`：
- 如果服务已在跑，**不重复启动**，打印：
  ```
  AgentQuad 已在 http://<host>:<port> 运行 (pid <pid>)
  停止：agentquad stop ｜ 状态：agentquad status
  ```
  退码 0 退出。
- 如果 pid 文件存在但进程已死，清理 pid 文件后继续启动。

> 注：`agentquad start` 现有逻辑已经处理 pid 复用，默认 action 走同一条路径即可，不重复实现。

### 3.2 `src/cli.js` — 首跑向导（L2）

#### 触发条件

满足 **全部** 条件时，在 `runStart` 真正起服务之前先跑向导：

1. `~/.agentquad/config.json` **不存在**（"首跑"判据 —— 走 autoMigrate 后如果是从 `~/.quadtodo/` 迁过来的，那个里面已有 config，不算首跑）
2. `process.stdin.isTTY === true` 且 `process.stdout.isTTY === true`
3. 环境变量 `AGENTQUAD_SKIP_WIZARD` **未设置**为 `1` / `true`
4. 命令行没传 `--no-wizard` 标志（新增）
5. 默认 action 触发（即 `agentquad` 裸跑），**或** `agentquad start` 显式跑且也满足上面 1-3 条 —— 显式 `start` 走向导更符合直觉

#### 向导流程

用 `readline` 实现，**最多 2 个问题**：

```
👋 第一次启动 AgentQuad。

[1/2] 检测到未安装：claude, codex（AI 终端必需）
      运行 `agentquad install-tools --all` 自动安装？(Y/n)

[2/2] 选择默认 AI 工具 (claude / codex) [默认: claude]:
```

- 第 1 步若 `which claude` 与 `which codex` 都通过，**跳过** 这一步
- 第 1 步用户回 N，**继续启动**（服务能起，AI 终端用户首次点击时会看到 `tool_missing` 提示卡片 —— 现有逻辑）
- 第 1 步用户回 Y，调用 `runInstallTools({ all: true })` 同步装，装完续走第 2 步
- 第 2 步只有装完 / 已经装好的工具集合内提供选择，写入 `config.defaultTool`
- 任何一步 Ctrl+C → 取消向导但**仍然启动服务**（用户已经敲了 `agentquad`，不该强行退出）

#### 实现位置

新增 `src/first-run-wizard.js`，导出 `runFirstRunWizard({ tools, configPath, stdin, stdout })`：
- 输入注入式（`tools` 接受 `{ checkClaude, checkCodex, installTools }`、`stdin/stdout` 默认 `process.stdin/stdout`），便于单测
- 返回 `{ skipped: false, installedTools: ['claude'], defaultTool: 'claude' }` 等结构供 cli.js 写入 config

### 3.3 `src/server.js` — 端口 +1 重试（一次）

#### 改动点

`server.listen(port, host, cb)` 改为：

```js
async function listenWithRetry(server, port, host, { maxAttempts = 2 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port + i, host)
      })
      return port + i // 返回真正使用的 port
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || i === maxAttempts - 1) throw err
      console.warn(`端口 ${port + i} 已被占用，尝试 ${port + i + 1}...`)
    }
  }
}
```

- **重要**：成功 listen 后用真实端口回写 banner（不能直接用 config 里的 port）
- 重试次数限制为 **2 次**（原端口 + 原端口+1）。再失败就报错退出，避免无脑 +1 跑到 65535
- 错误信息附 fix 提示：`agentquad config set port <new-port>`
- 真正使用的 port 必须传回 `runStart`，让 banner、`open()` 跳转、pid 文件里的 metadata 都用真实值
- 注意：如果 `--port` 显式传了，仍然走 +1 重试（用户期望"启动成功"高于"严格端口"）

#### Pid 文件

现有 pid 文件只存 pid，不存 port —— 改为 JSON：

```json
{ "pid": 12345, "port": 5678, "host": "127.0.0.1", "startedAt": "2026-05-13T..." }
```

读侧：
- 老格式（纯数字）兼容 —— `JSON.parse` 失败时 fallback 到 `Number(content)`，但取不到 port 时回退到 config.port
- `status` 命令显示真实 port
- `stop` 命令照旧只关心 pid

### 3.4 `package.json` 同步

- bump version `0.2.0` → `0.3.0`
- 不改 `bin` / `files` / `engines` / `os`
- 不加 postinstall 启动逻辑（坚决不做）

### 3.5 `README.md` 改动

`## 30 秒上手` 这一段简化为：

```markdown
## 30 秒上手

```bash
npm install -g agentquad
agentquad                          # 第一次会引导装 claude / codex
```

> 浏览器自动打开 http://127.0.0.1:5677
> 不想引导：`AGENTQUAD_SKIP_WIZARD=1 agentquad` 或 `agentquad --no-wizard`

> **平台**：仅支持 macOS / Linux；Windows 暂不支持，规划中。
```

「命令」表格里给 `agentquad`（无参数）单独加一行说明："默认行为：等价于 `agentquad start`，首次启动时会引导装 AI 工具"。

`agentquad start` 那一行 options 增加 `--no-wizard`：跳过首跑向导。

### 3.6 `docs/RELEASE.md`（已存在，**补充**而非新建）

如果文件不存在则新建，存在则在末尾追加 "Release hygiene checklist for 0.3.0" 章节：

```markdown
## 发版前清单（每次发版都要过一遍）

- [ ] 仓库根目录无遗留 `*.tgz`（旧的 `quadtodo-*.tgz` / `agentquad-*.tgz` 都删掉）
- [ ] `web/node_modules` 已装（不在的话 `npm run setup`）
- [ ] `npm pack --dry-run` 输出确认：
  - 包含 `dist-web/index.html`
  - 包含 `src/cli.js`、`src/server.js`
  - 体积 < 10 MB
  - **不**包含 `node_modules/` / `web/node_modules/` / `tmp/` / `mira-proxy/` / `*.test.js`
- [ ] 干净目录跑 `npm i -g ./agentquad-0.3.0.tgz` 不报 native 编译
- [ ] `which agentquad` 返回路径，`agentquad --version` 输出 `0.3.0`
- [ ] `agentquad` 裸跑：首次进向导 → 装工具 → 起服务 → 自动开浏览器
- [ ] `agentquad` 二次跑：直接起服务，不再问向导
- [ ] 占用 5677 后 `agentquad`：自动用 5678 起，banner 显示真实端口
- [ ] `npm publish --dry-run` 列表确认
- [ ] `npm publish`
- [ ] `npm view agentquad version` = `0.3.0`
```

### 3.7 旧 tarball 清理

仓库根目录有 `quadtodo-0.1.1.tgz`（package.json 已经是 `agentquad@0.2.0`），属于"留在仓库的旧产物"。
- 删除该文件
- 在 `.gitignore` 加 `*.tgz`，防止未来再次提交

## 4. 测试计划

### 4.1 单元测试 (`test/`)

| 测试文件 | 覆盖点 |
|---|---|
| `test/cli-default-action.test.js` | `agentquad`（无参数）触发 `runStart` 而非打印 help |
| `test/first-run-wizard.test.js` | 工具齐全跳过向导；缺 claude 触发安装确认；用户回 N 不阻塞启动；非 TTY 自动跳过；`AGENTQUAD_SKIP_WIZARD=1` 跳过 |
| `test/listen-with-retry.test.js` | EADDRINUSE 时 +1 重试成功；连续 2 次失败抛出；非 EADDRINUSE 立即抛出；成功返回真实端口 |
| `test/pid-file-format.test.js` | 写入 JSON 格式；读到 JSON 取得 port/host；读到老格式纯数字 fallback；进程死了清理 pid |

### 4.2 手测清单（合并到 RELEASE.md）

见 3.6 节末尾的清单。

### 4.3 回归测试

- `npm run test` 跑全套，原有测试不能 break
- 现有 `agentquad start` / `stop` / `status` / `doctor` / `install-tools` 输出与行为不变
- `quadtodo` alias 同步获得默认 action 与向导行为（同一份 cli.js，自动生效）

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| commander 的"默认 action"在没传子命令时也匹配，但 `--help` / `-V` 不会触发 | 已验证 commander 文档；测试用例覆盖 |
| 默认 action 误吞错误（用户 typo 了子命令名 `agentqudo strat`） | commander 现有 `program.allowUnknownOption(false)`（默认）会先拦住未知子命令；默认 action **只**在无 args 时触发 |
| 首跑向导卡死 stdin（如用户 SSH 上来跑且 stdin 异常） | 检测 `process.stdin.isTTY` 为 false 直接跳过；`AGENTQUAD_SKIP_WIZARD=1` 兜底 |
| 端口 +1 重试影响"用户显式指定 port 应该报错"的预期 | 文档明示 +1 是默认行为；用户想严格端口可以 `AGENTQUAD_STRICT_PORT=1`（**本期不实现**，留意见若有人提再加） |
| Pid 文件升级到 JSON，外部脚本依赖纯数字格式 | 读侧 fallback 保留老格式；`stop` 只关心 pid 字段，旧脚本 `kill $(cat ~/.agentquad/agentquad.pid)` **会因为是 JSON 而失败** —— 这是 break |
| ↑ 同上 | 在 RELEASE notes / README 故障排除段加一句 "0.3.0 起 pid 文件改 JSON 格式，请用 `agentquad stop` 而非手动 kill" |
| 向导误判"首跑"（用户删了 config.json 但保留 data.db） | 判据改为 `config.json` 不存在 **且** `data.db` 也不存在 —— 防止误触 |
| install-tools 装失败但向导继续起服务，用户困惑 | 向导失败时打印明确提示 "工具安装失败，AI 终端将不可用。修复后跑 `agentquad install-tools --all`" |

## 6. 验收标准

- [ ] 干净 macOS Node 20 机器：`npm i -g agentquad && agentquad` 一行起服务 + 开浏览器（向导走完）
- [ ] 二次 `agentquad`：不再问向导，直接起服务（< 2s 到 banner）
- [ ] 占用 5677 后 `agentquad`：banner 显示用 5678 起，浏览器打开 `http://127.0.0.1:5678`
- [ ] 占用 5677 + 5678 后 `agentquad`：报错退出，提示 `agentquad config set port <new>`
- [ ] `agentquad --help` 仍显示完整子命令列表
- [ ] `agentquad start` 显式跑：行为与现在完全一致（向导仍可触发，但 `--no-wizard` 能跳过）
- [ ] `agentquad stop` / `status` 在 JSON pid 文件下正常工作
- [ ] `AGENTQUAD_SKIP_WIZARD=1 agentquad` 跳过向导直接起
- [ ] CI 环境（非 TTY）`agentquad` 跳过向导，正常起服务
- [ ] `quadtodo` alias 行为与 `agentquad` 一致
- [ ] `npm pack` 产物 < 10 MB，包含必要文件，不含 tmp/test/node_modules
- [ ] 仓库根目录无 `*.tgz`，`.gitignore` 已加规则
- [ ] 全部新单测通过，原有测试无 regression

## 7. 工作量估计

约半天到 1 天：
- 默认 action + `runStart` 抽取：1-2 小时
- 首跑向导 + 单测：2-3 小时
- 端口 +1 重试 + 单测：1 小时
- Pid 文件 JSON 化 + 兼容 + 单测：1 小时
- README + RELEASE.md：30 分钟
- 旧 tgz 清理 + .gitignore + 真实 `npm pack` dry-run：30 分钟
- 回归 + 手测：1 小时
