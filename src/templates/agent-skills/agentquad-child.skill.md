---
name: agentquad-child
description: |
  Use when the user wants to split the current AgentQuad task into a sub-task and delegate it to another AI agent. Activates inside AgentQuad-launched sessions (env QUADTODO_SESSION_ID present) or when the user explicitly mentions AgentQuad / 四象限 todo.
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
3. （可选）`start_ai_session(todoId=<子 id>, parentTodoId=<env QUADTODO_TODO_ID 的值>, tool="claude"|"codex", prompt=<明确任务说明>)`
4. 把 ticket / 子 id 告诉用户

## 重要约束
- 拆子任务前先**和用户对齐范围**，不要无脑拆
- 不要为了拆而拆 —— 子任务必须有清晰的、独立可完成的目标
- `start_ai_session` 默认 `permissionMode=bypass`，子 agent 默认有写权限，慎重
