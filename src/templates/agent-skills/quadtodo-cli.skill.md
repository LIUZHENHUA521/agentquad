---
name: quadtodo-cli
description: |
  Use when the user wants to create, list, complete, update, comment on, or delete AgentQuad / 四象限 todos from the terminal (not the web UI). Triggers on "记一条待办 / 加个 todo / 把这个建成待办 / 列一下待办 / 标记完成 / agentquad todo / quadtodo todo". Drives the local `quadtodo todo` CLI over the running AgentQuad server.
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
