# Nested Child Agents — 嵌套子代办与子 agent 设计

- **状态**: Draft
- **日期**: 2026-05-14
- **作者**: 与用户 brainstorm 后撰写
- **关联**:
  - 现有 MCP 实现：`src/mcp/server.js`、`src/mcp/tools/openclaw/index.js`
  - 现有 OpenClaw 微信桥：`docs/superpowers/specs/2026-04-29-openclaw-quadtodo-bridge-design.md`
  - 现有 hook 三家适配：`src/templates/{claude,codex,cursor}-hooks/`

## 1. 目标与范围

让 AgentQuad 启动的 Claude Code / Codex 会话，以及用户日常使用的 Cursor，都能：

1. 自动连上当前实例的 AgentQuad MCP 服务（`http://127.0.0.1:<port>/mcp`）
2. 在合适场景下自发调 `create_todo` + `start_ai_session`，把当前任务拆出子 todo 并交给另一个 agent

**不在本期范围**：
- "工作台全局 AI"（顶栏常驻聊天位 / 自然语言条创建 todo）—— 留到 Phase 2
- 用户运行其它工具时通过 AgentQuad MCP 反向控制（如远程开 todo）—— 已由 OpenClaw 路径覆盖
- 跨机分布式 agent 协作

## 2. 关键决策（已与用户拍板）

| # | 决策 | 选择 |
|---|---|---|
| Q1 | 实施次序 | 先做嵌套 child agent，全局工作台 AI 留到 Phase 2 |
| Q2 | 是否安装 skill 文件 | 装全局 skill；提供安装命令 |
| Q3 | MCP 怎么对接 | B 全局注册 + C 运行时注入，都做 |
| Q4 | 三家适配深度 | Claude Code(B+C+skill)；Codex(B+C 待查+skill)；Cursor(B+全局 rule) |
| Q5 | 安装时机 | 显式命令 + `agentquad start` 自动 bootstrap（带 prompt 确认） + `agentquad doctor` 集成，三入口共享 installer |
| Q6 | 递归深度限制 | 不限深度、不限并发，纯靠 LLM 自律；保留软 warning（活跃 PTY 数 ≥ 阈值闪烁） |

## 3. 架构总览

### 3.1 新增/改动的模块

```
src/
├── agents/                          ← 新增模块
│   ├── installer.js                 ← 统一安装器调度（preview/apply/remove/health）
│   ├── targets/
│   │   ├── claude.js                ← Claude Code 适配（B + C + skill）
│   │   ├── codex.js                 ← Codex 适配（B + C 待查 + skill）
│   │   └── cursor.js                ← Cursor 适配（B + global rule）
│   ├── skill-content.js             ← skill / rule 正文生成（一份内容三家复用）
│   ├── runtime-config.js            ← 运行时 MCP 配置文件读写（C）
│   └── doctor.js                    ← 给 `agentquad doctor` 喂状态
├── templates/agent-skills/          ← 静态资源
│   ├── agentquad-child/SKILL.md     ← Claude/Codex 共用的 skill 文件
│   └── cursor/agentquad.mdc         ← Cursor rule 文件
├── cli.js                           ← 加 `agentquad agents` 子命令组
├── mcp/tools/openclaw/index.js      ← start_ai_session 改：注入 --mcp-config + env
└── ai-terminal.js（或同等位置）      ← spawnSession 注入 QUADTODO_DEPTH/PARENT_TODO_ID + 运行时 MCP 配置
```

### 3.2 高层数据流（嵌套创建子 todo + agent）

```
父 PTY (Claude Code, todo A)
  │ LLM 看到 "agentquad-child" skill 描述 → 决定拆任务
  ↓ MCP call: create_todo(title=..., parentId=A, quadrant=2)
AgentQuad MCP
  │ DB 写入 todo B（parentId=A）
  ↓ MCP call: start_ai_session(todoId=B, tool="claude")
AgentQuad MCP
  │ aiTerminal.spawnSession(...)
  │   - 拼命令行：claude --mcp-config <run/mcp-{sid}.json> ...
  │   - 注入 env: QUADTODO_SESSION_ID/TODO_ID/TODO_TITLE/URL/DEPTH/PARENT_TODO_ID
  ↓
子 PTY (Claude Code, todo B)
  │ 启动后通过 --mcp-config 连上 AgentQuad MCP
  │ 通过 env 知道自己是嵌套会话（DEPTH=1）
  ↓ Web UI 实时看到新 todo + 新 session（已有的实时机制）
```

### 3.3 statelessness / 幂等性原则

- 所有写到用户全局配置的内容都用 **marker 段**包裹，apply 即重写、remove 即按 marker 删
- 运行时 MCP 配置文件（C）一会话一文件，PTY 退出即删，`agentquad doctor` 兜底扫孤儿
- B 写入的 marker 段携带 `# agentquad-version, port` 注释，端口漂移可被检测并自动同步

## 4. 三家适配细节

### 4.1 Claude Code

| 维度 | 做法 |
|---|---|
| **B 全局 MCP** | 写到 `~/.claude.json`，等价 `claude mcp add agentquad --transport http --url http://127.0.0.1:<port>/mcp`。**JSON 不支持注释**，marker 通过在 `mcpServers.agentquad` 同级写元数据字段 `_agentquadManaged: { version, port, generatedAt }` 实现；或独立 lockfile `~/.claude/agentquad.lock.json` 存元数据（plan 阶段二选一） |
| **C 运行时注入** | `aiTerminal.spawnSession` 拼命令行加 `--mcp-config <临时文件>`。临时文件路径 `~/.agentquad/run/mcp-<sessionId>.json`，会话退出后 cleanup 删除 |
| **全局 skill** | 复制 `src/templates/agent-skills/agentquad-child/SKILL.md` 到 `~/.claude/skills/agentquad-child/SKILL.md` |
| **触发条件** | skill 的 frontmatter `description` 写明"在 AgentQuad 启动的会话里（检测 `QUADTODO_SESSION_ID` env）+ 用户提到拆子任务/起新 agent 时使用" |

### 4.2 Codex

| 维度 | 做法 |
|---|---|
| **B 全局 MCP** | 写到 `~/.codex/config.toml`，加 `[mcp_servers.agentquad]` 表，marker 注释包起来。优先用 `codex mcp add`（若可用），fallback 直接写文件 |
| **C 运行时注入** | plan 阶段先验证 `codex` CLI 是否有 `--mcp-config` 或环境变量等价物（见 §13 开放问题）。若有 → 照搬 Claude 模式；若无 → **退化策略 = 在 `spawnSession` 前往项目目录写 `.codex/config.toml`（trusted projects only），退出时清理**（已与用户确认接受该副作用） |
| **全局 skill** | 复制同一份 SKILL.md 到 `~/.codex/skills/agentquad-child/SKILL.md` |
| **不改动** | 不修改用户的 `~/.codex/AGENTS.md` —— 那是用户/项目内容 |

### 4.3 Cursor

| 维度 | 做法 |
|---|---|
| **B 全局 MCP** | 写到 `~/.cursor/mcp.json`，加 `mcpServers.agentquad` 字段。marker 通过 `_agentquadManaged: true` 旁路键标识 |
| **C 运行时注入** | **不做**。Cursor 不是 AgentQuad spawn 的 PTY，没有命令行控制点 |
| **全局 rule** | 写到 `~/.cursor/rules/agentquad.mdc`，frontmatter 用 `description` 模式（Agent Requested 激活）。**不写到任何项目目录**，避免污染用户代码仓 |
| **能力差异** | Cursor 里没有 `QUADTODO_SESSION_ID` env，rule 描述写成"当用户提到 quadtodo / agentquad / 四象限 todo 时激活"。Cursor 调 `start_ai_session` 时仍可拉起 Claude Code / Codex 子 agent（顶层 todo） |

### 4.4 skill / rule 正文骨架

一份 `SKILL.md` 内容，Claude/Codex 直接复用，Cursor 转成 `.mdc` 格式（frontmatter 不同，正文相同）：

```markdown
---
name: agentquad-child
description: |
  Use when the user wants to split the current AgentQuad task into a sub-task
  and delegate it to another AI agent. Activates inside AgentQuad-launched sessions
  (env QUADTODO_SESSION_ID present) or when the user explicitly mentions AgentQuad / 四象限 todo.
---

# AgentQuad 子任务委派

## 你身处的环境
- 你运行在 AgentQuad（本地四象限 AI 任务调度器）里
- 父任务的 ID 在环境变量 `QUADTODO_TODO_ID`，标题在 `QUADTODO_TODO_TITLE`
- AgentQuad 的 MCP 服务地址在 `QUADTODO_URL`（已通过 mcp 连接，无需手动配置）
- `QUADTODO_DEPTH` 表示嵌套层级（0=顶层，1+=被另一个 agent 启动）

## 何时触发本 skill
- 用户说"把 X 拆出去 / 另起一个 agent 干 / 开个分支任务"
- 你判断当前任务过大、应该拆分
- 用户主动要求创建/查看/管理 AgentQuad todo

## 操作流程
1. `list_quadrants` → 决定子任务放哪个象限（默认 Q2 重要不紧急）
2. `create_todo(title, quadrant, parentId=<父 TODO_ID>, description)` → 拿到子 todo id
3. （可选）`start_ai_session(todoId=<子 id>, tool="claude"|"codex", prompt=<明确任务说明>)`
4. 把 ticket / 子 id 告诉用户

## 重要约束
- 拆子任务前先**和用户对齐范围**，不要无脑拆
- 不要为了拆而拆 —— 子任务必须有清晰的、独立可完成的目标
- `start_ai_session` 默认 `permissionMode=bypass`，子 agent 默认有写权限，慎重
```

Cursor `.mdc` 的 frontmatter 替换为：

```mdc
---
description: Use when the user mentions quadtodo / agentquad / 四象限 todo or wants to split a task into sub-tasks delegated to AI agents.
alwaysApply: false
---

（正文同上）
```

## 5. 安装 / 卸载 / 自检

### 5.1 统一 installer 接口（`src/agents/installer.js`）

每个 target（claude/codex/cursor）实现同一组方法，installer 负责调度：

```js
{
  name: 'claude' | 'codex' | 'cursor',
  detect(): { installed: boolean, version: string|null, configPath: string },
  preview({ mcpUrl, skillSourceDir }): Plan[],   // 列出要做的写操作（dry-run）
  apply(plan): { ok, written: string[], errors: [] },
  remove(): { ok, removed: string[], errors: [] },
  health({ mcpUrl }): { mcpRegistered, mcpUrlOk, skillPresent, drift: boolean },
}
```

### 5.2 三个入口（共享 installer）

#### A. 显式命令

```bash
agentquad agents install                    # 默认装能检测到的三家
agentquad agents install --target claude    # 单独装
agentquad agents install --dry-run          # 只 preview 不写
agentquad agents uninstall [--target X]
agentquad agents status                     # 表格：每家 detect + health
```

#### B. `agentquad start` 自动 bootstrap

```js
async function bootstrapAgents({ interactive }) {
  const plans = await Promise.all(targets.map(t => t.preview(...)))
  const needed = plans.filter(p => p.changes.length > 0)
  if (needed.length === 0) return

  if (interactive && process.stdin.isTTY) {
    // 提示：检测到 X 个 agent 工具未配置（claude, codex），是否安装？[Y/n]
    const ok = await prompt(...)
    if (ok) await apply(needed)
    else markBootstrapDismissed()
  } else {
    console.warn('[agents] 未安装的工具:', needed.map(p => p.name).join(', '),
                 '运行 `agentquad agents install` 启用')
  }
}
```

两个保险：
- 配置 `agents.autoBootstrap: 'prompt' | 'never' | 'silent'`（默认 `prompt`）
- 用户拒绝过一次 → `~/.agentquad/state.json` 写 `agents.bootstrapDismissed = true`，下次不再问

#### C. `agentquad doctor` 集成

```
agents:
  claude    ✓ MCP registered  ✓ skill installed     (~/.claude.json)
  codex     ✗ MCP missing     ✓ skill installed     (修复: agentquad agents install --target codex)
  cursor    ✓ MCP registered  ✗ rule missing        (修复: agentquad agents install --target cursor)
  ─ drift:  codex.mcp.url 指向 :5677，但当前 port=5678（修复: agentquad agents install --target codex）
  ─ warning: 当前活跃 AgentQuad PTY 数 = 9（≥ 阈值 8，请留意是否失控）
```

### 5.3 端口漂移处理

- installer 在 marker 元数据里写 `version` + `port` + `generatedAt`（TOML 写注释行，JSON 写旁路字段，由 plan 阶段决定 §13）
- `agentquad start` 启动后比对：当前实际 port 跟 marker 写的不一致 → **自动重写，不弹提示**（同一来源的更新，不需要用户决策）
- `agentquad doctor` 也比对，drift 显式报出来

### 5.4 卸载

- `agentquad agents uninstall` 调每家的 `remove()`，按 marker 删
- 兜底 `--force` 跳过 marker 校验，直接删整个 `mcpServers.agentquad` / skill 目录
- 卸载也清掉 `~/.agentquad/run/mcp-*.json` 运行时残留

### 5.5 失败 / 异常处理

- 单个 target apply 失败不阻断其它 target（汇总错误）
- 文件不存在 → 自动创建父目录后写
- 文件存在但格式坏（如 `~/.codex/config.toml` 解析失败）→ 报错并提示用户备份后重跑，**不强行覆盖**
- `mcpUrlOk` 检测只做一次 HTTP HEAD（带短超时），不阻塞 doctor
- 并发写：写文件统一用 `O_EXCL` 临时文件 + rename 原子替换

## 6. 运行时注入（C）实现细节

`spawnSession` 改造点（伪代码）：

```js
// 1. 计算 depth（即使不限制也存起来观测）
const parentDepth = Number(process.env.QUADTODO_DEPTH || -1)
extraEnv.QUADTODO_DEPTH = String(parentDepth + 1)
extraEnv.QUADTODO_PARENT_TODO_ID = parentTodoId || ''

// 2. 写运行时 MCP 配置文件
const runtimeMcpConfigPath = await writeRuntimeMcpConfig({
  sessionId, port, tool,   // tool=claude → claude 格式；codex → codex 格式
})

// 3. 拼命令行
//    claude: claude --mcp-config <path> ...
//    codex:  待 spec 阶段确认 --mcp-config / env 等价物，否则项目目录临时锚点
const args = buildAgentArgs(tool, { mcpConfigPath: runtimeMcpConfigPath, prompt, ...rest })

// 4. 退出 cleanup
pty.on('exit', () => { try { fs.unlinkSync(runtimeMcpConfigPath) } catch {} })
```

**合并语义**：当 B（全局注册）和 C（运行时注入）都存在时，Claude Code 合并两个来源 —— 运行时优先。这保证当前 PTY 永远用 live 端口，即使 B 的 marker 段还没更新。

**孤儿清理**：`agentquad doctor` 扫 `~/.agentquad/run/`，删除超过 24h 没对应活跃 session 的孤儿文件。

## 7. 配置 schema

```js
{
  agents: {
    autoBootstrap: 'prompt',          // 'prompt' | 'never' | 'silent'
    bootstrapDismissed: false,        // 用户拒绝过后置 true（由 CLI 写）
    enabled: {                        // 细粒度开关
      claude: true,
      codex: true,
      cursor: true,
    },
    runtimeDir: '~/.agentquad/run',   // 运行时 MCP 配置文件目录
    warnPtyCount: 8,                  // doctor 软 warning 阈值
  }
}
```

`agentquad config set agents.enabled.cursor false` 即可关掉某家。

## 8. 文件落点总览

| 路径 | 谁写 | 内容 | 卸载怎么处理 |
|---|---|---|---|
| `~/.claude.json` | installer | marker 包 `agentquad` MCP 入口 | 移除 marker 段 |
| `~/.claude/skills/agentquad-child/SKILL.md` | installer | 子任务委派 skill 全文 | 删目录 |
| `~/.codex/config.toml` | installer | marker 包 `[mcp_servers.agentquad]` | 移除 marker 段 |
| `~/.codex/skills/agentquad-child/SKILL.md` | installer | 同 Claude 的 skill（一份内容） | 删目录 |
| `~/.cursor/mcp.json` | installer | `mcpServers.agentquad` 字段 | 删 key |
| `~/.cursor/rules/agentquad.mdc` | installer | Cursor 全局 rule | 删文件 |
| `~/.agentquad/run/mcp-<sid>.json` | spawnSession | 运行时 MCP 配置（Claude/Codex 各自格式） | PTY 退出自动删 + doctor 兜底扫 |
| `~/.agentquad/state.json` | CLI | `agents.bootstrapDismissed` 等持久状态 | 不动 |

## 9. 验收标准

### 功能

- [ ] `agentquad agents install` 三家全装：目标文件存在 + marker 段正确 + skill 文件存在
- [ ] `agentquad agents install --target claude` 单装；`uninstall --target claude` 只删 Claude 段，其它不受影响
- [ ] `agentquad agents status` 输出三家状态表，已装/未装/drift 都能识别
- [ ] `agentquad agents install --dry-run` 不写任何文件，只输出 plan
- [ ] `agentquad start` 首次启动且 stdin 是 TTY 时弹问；用户回 N 后 `bootstrapDismissed=true`，下次不再问；`--no-bootstrap-prompt` flag 跳过
- [ ] `agentquad doctor` 输出 agents 段，drift 检测准确（手动改端口能复现）；活跃 PTY ≥ 8 时显示软 warning
- [ ] 重复 `install` 是幂等的（文件 hash 不变 / marker 段内容稳定）

### 嵌套链路（端到端）

- [ ] 通过 web 在 Q2 新建一个 todo，用 Claude Code 启动
- [ ] 在该 PTY 内输入"把这个任务拆成两个子任务，先把子任务 1 交给另一个 agent"
- [ ] LLM 自发调 `create_todo`（两次，`parentId` 都是当前 todo）+ `start_ai_session`（一次，针对子任务 1）
- [ ] Web 实时显示两个新子 todo + 一个新活跃 PTY
- [ ] 子 PTY 内 `env | grep QUADTODO_` 能看到 `DEPTH=1`、`PARENT_TODO_ID=<父>`
- [ ] 子 PTY 内 LLM 也能继续调 MCP（验证子 PTY 确实连上了 AgentQuad MCP）

### 端口漂移

- [ ] 手动改 `port` 5677 → 5678，重启 AgentQuad
- [ ] `~/.claude.json` / `~/.codex/config.toml` / `~/.cursor/mcp.json` 里 `agentquad` MCP url 自动更新为 5678
- [ ] doctor 不再报 drift

### 卸载干净

- [ ] `agentquad agents uninstall` 后所有目标文件里的 marker 段消失
- [ ] 用户原本写的其它 MCP / skill 完全不动（事前手动加了别的 server 的 `~/.claude.json` 做对照）
- [ ] `~/.agentquad/run/` 下没有残留

### 回归

- [ ] 现有 OpenClaw 微信路径、ask_user、telegram hook、Lark hook 全部不受影响
- [ ] 现有 `start_ai_session` 调用方式（不带任何 agents 配置）依然能跑

## 10. 风险与缓解

| # | 风险 | 缓解 | 备注 |
|---|---|---|---|
| 1 | Codex CLI 没有 `--mcp-config` 等价 flag | C 退化为项目目录临时写 + 退出清理 | spec → plan 阶段需先确认；若无法接受副作用回到 brainstorm |
| 2 | 用户日常用 Claude Code 时 B 会让所有会话都看到 AgentQuad MCP，5677 端口没开时报错 | install 时打印一行说明"AgentQuad 不在跑时 Claude Code 启动会看到一行 MCP 连接失败，属预期" | 用户已接受 |
| 3 | 不限深度时 LLM 写出递归调用，PTY 爆炸 | doctor / web UI 软 warning（活跃 PTY ≥ `agents.warnPtyCount`） | 不强制，纯观测 |
| 4 | 用户全局配置文件被并发写坏 | `O_EXCL` 临时文件 + rename 原子替换 | 实现兜底 |
| 5 | skill 内容更新后覆盖用户改动 | marker 头写 version；version 不变就不覆盖；version 升级时提示用户 diff | 升级体验 |
| 6 | Cursor rule 触发条件不依赖 env，可能误激活 | `description` 明确"用户提到 quadtodo/agentquad/四象限 todo 时"，由 Cursor Agent Requested 模式自决 | 由 Cursor 自身机制兜底 |

## 11. 与现有系统的关系

- **OpenClaw 微信路径**：完全独立。微信端用户通过 OpenClaw skill 调 `start_ai_session` 拉起 PTY，本设计的"嵌套创建"是 **PTY 内的 Claude Code/Codex 再调 MCP** —— 用同一个 MCP server，不冲突
- **现有 hook 三家适配**：完全独立。Hook 是 PTY 内 AI 工具的 stop hook，本设计是给 PTY 内 AI 提供工具入口，两者解耦
- **`start_ai_session` 现有参数**：`tool: ['claude','codex']` 不变，Cursor 不在 `tool` enum 里（Cursor 不能被 spawn）。新增注入 `QUADTODO_DEPTH`、`QUADTODO_PARENT_TODO_ID` env，对存量调用无影响

## 12. Phase 2 预告（不在本期实现）

- 全局工作台 AI：Web 顶栏常驻聊天位 / Cmd-K 自然语言条 → 复用本期的 MCP 工具集 + 一条"无 todo 的 LLM 通道"
- 跨工具 agent 间消息广播（父 agent 给子 agent 发指令）
- 子 agent 完成后的"汇总回报"自动触发（子 done → 父 PTY 收到通知）

## 13. 开放问题（plan 阶段需确认）

- Codex CLI 的 `--mcp-config` / 等价机制 → 查 [Codex CLI 命令行参考](https://developers.openai.com/codex/cli/reference)
- JSON 文件（`~/.claude.json`、`~/.cursor/mcp.json`）的 marker 实现方式二选一：
  - **方案 A（推荐）**：在 `mcpServers.agentquad` 同级 / 旁路写元数据字段 `_agentquadManaged: { version, port, generatedAt }`
  - **方案 B**：在 `~/.claude/`、`~/.cursor/` 下放独立 lockfile `agentquad.lock.json` 存元数据，目标文件保持纯净
  - 三家用同一方案保持一致性
- 三家在 macOS / Linux 下的实际文件权限 / 路径差异
