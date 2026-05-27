---
name: quadtodo-cli
description: |
  Use when the user wants to create, list, complete, update, comment on, delete, or START WORKING ON (派 agent 开干) AgentQuad / 四象限 todos from the terminal (not the web UI). Triggers on "记一条待办 / 加个 todo / 把这个建成待办 / 列一下待办 / 标记完成 / 建完直接开干 / 一键开干 / agentquad todo / quadtodo todo". Drives the local `quadtodo todo` CLI over the running AgentQuad server.
---

# AgentQuad 待办 CLI

用 `quadtodo todo` 子命令（等价 bin：`agentquad todo`）在终端里增删改查待办。
所有命令打的是本机正在运行的 AgentQuad server（HTTP），所以**写入会实时反映到 Web 看板**，
且和在 UI 里操作行为完全一致（比如标记 done 会自动关掉该 todo 的 AI 终端会话）。

## 前置：server 必须在跑

任何 `todo` 命令前，确认 server 在跑：

```bash
quadtodo status        # 不在跑就 `quadtodo start`
```

命令报 `AgentQuad server 没在跑` 时，先 `quadtodo start` 再重试。

## 命令速查

```bash
# 新建（只有 title 必填）
quadtodo todo add "修复登录超时" -d "复现路径见 #123" --due 2026-06-01 -w ~/code/app

# 列出（默认只看未完成；--status all/done 看全部/已完成）
quadtodo todo list
quadtodo todo list --status all -k 登录

# 看详情（含描述 / 子任务 / 评论 / AI 会话）
quadtodo todo show <id>

# 标记完成
quadtodo todo done <id>

# 改字段
quadtodo todo update <id> -t "新标题" --stage review --due clear

# 评论
quadtodo todo comment <id> "已联系运维，等回滚窗口"

# 删除（级联删子任务，不可逆；脚本里需 -y）
quadtodo todo rm <id> -y
```

## 一键开干（建/选一条待办 → 派 agent 进去干活）

`todo start <id>` 会在该 todo 上起一个内嵌 AI 终端会话；`todo add ... --start` 则建完立即开干。

**关键约定：开干前一定先问用户用哪个 agent**（claude / codex / cursor），拿到答复再带 `--tool` 调用——不要替用户默认选一个。CLI 在交互终端下没给 `--tool` 会自己弹菜单，但你（AI）是非交互调用，必须显式问用户、再传 `--tool`。

```bash
# 已有待办上开干（先问用户：claude / codex / cursor？）
quadtodo todo start <id> --tool claude --prompt "把登录超时复现并修掉，跑通相关测试"

# 建完直接开干（同样先问 agent）
quadtodo todo add "修复登录超时" -w ~/code/app --start --tool codex --prompt "见标题，先复现再修"
```

- 不传 `--prompt` 时默认用该 todo 的「标题 + 描述」当指令。
- 不传 `--cwd` 时用该 todo 的 `workDir`，没有则用服务端默认目录。
- `--perm` 控制权限：`default`（每次问）/ `plan`（只读规划）/ `bypass`（放开写，谨慎）。
- agent 没装会报错并给出 `agentquad install-tools --<tool>` 修复提示。

典型对话流：用户说「把这个建成待办然后开干」→ 你先 `todo add` 建好 → **回问一句"用哪个 agent？claude / codex / cursor"** → 用户选 → 你 `todo start <id> --tool <选的>`（或一开始就 `add --start --tool`）。

## 给自动化/脚本用

每个读写命令都支持 `--json`，stdout 输出结构化结果，便于解析后续步骤拿 `id`：

```bash
ID=$(quadtodo todo add "跑回归测试" --json | jq -r .id)
quadtodo todo comment "$ID" "已排期到今晚"
```

`--status` 取值：`todo`（默认）/ `done` / `all`。
`--due` 接受 ms epoch、ISO 时间串或 `YYYY-MM-DD`；`update --due clear` 清除截止时间。
`--stage` 取值：`dev` / `review` / `test` / `release` / `blocked`。

## 何时用 CLI vs MCP

- **CLI（本 skill）**：快速、命令式、可塞进 shell 脚本和管道；适合"顺手记一条 / 批量列出 / 标记完成"。
- **MCP 工具**（`create_todo` / `list_todos` / `search` 等，见 docs/MCP.md）：在已连 MCP 的会话里做需要检索、合并、读 transcript 的更复杂操作。

两者操作同一个本地数据库，可混用。
