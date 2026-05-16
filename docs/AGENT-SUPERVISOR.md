# Agent Supervisor（守望者）

> 让 AI 替主人盯着所有 todo session，最后只在「需要验收」时叫你。

## 目标

- 全局开关：一键开启/关闭"AI 替我做决策"
- 自动决策官：当 session 卡在权限弹窗 / `ask_user` 时，调用 Claude Opus 4.7 在白名单选项里给出决策，置信度过线就直接帮你回
- 主动推进：每个 running/idle session 定时复诊，如果不到验收标准就给它一个推进 prompt
- 浏览器代驾：可选给 session 注入 `claude-in-chrome` MCP，让 AI 自己点网页（默认关，避免并发抢同一个 Chrome）
- 审计 + 撤销：每次代决策都写 audit log，前端"代决策时间线"可看可撤销

## 分阶段

### Phase 1（本期）— 守望者骨架 + 权限弹窗自动决策

> ⚠️ **不调 Anthropic API**——主人没买 API key。守望者用主人本地已装好并登录的
> `claude` / `codex` / `cursor-agent` CLI，以 headless 模式（`-p` / `exec`）做判断。
> 所有 token 消耗都走主人现有的订阅，不会额外扣费。

1. **配置**：在 `config.js` 加 `agentSupervisor`：
   - `enabled`（全局开关，默认 false）
   - `tool`（用哪个 CLI：`claude` / `codex` / `cursor`，默认 `claude`）
   - `model`（可选：传给 CLI 的 `--model`；空 = 用 CLI 默认）
   - `timeoutMs`（单次决策超时，默认 60s）
   - `threshold`（默认 0.8）
   - `allowlist`（默认 `['allow', 'yes', 'continue', 'proceed', 'approve']`）
   - `permissionAuto`（默认 true，是否处理 PTY 权限弹窗）
   - `askUserAuto`（默认 true，是否处理 ask_user MCP 弹窗）
2. **DB**：新表 `agent_decisions(id, todo_id, session_id, kind, prompt, options, choice, confidence, reason, model, tokens_in, tokens_out, ms, status, created_at)`
3. **模块**：`src/agent-supervisor.js`
   - `decide({ kind, todoTitle, todoDescription, promptText, options, recentOutput, cwd })` → spawn 配置的 CLI（claude `-p --output-format text` / codex `exec` / cursor `-p --output-format text`），prompt 走 stdin，返回 `{ choice, confidence, reason }`
   - 自带白名单过滤、阈值检查、超时、错误降级
4. **接入**：
   - `pending-questions.js`：`ask()` 创建 pending 后立即异步问 supervisor；命中就 `submitReply()`
   - `routes/ai-terminal.js` `markPendingConfirm`：翻 pending_confirm 后异步问 supervisor；命中就 `pty.write(sessionId, '\r')`（Allow）或 `'\x1b'`（Esc/Deny）
5. **API**：`src/routes/agent-supervisor.js`
   - `GET /api/agent-supervisor/status` — 当前配置 + 最近 audit
   - `POST /api/agent-supervisor/config` — 更新配置
   - `GET /api/agent-supervisor/decisions` — 分页 audit
6. **Web UI**：`SettingsDrawer` 加新 section + 单独的"代决策时间线"小抽屉
7. **测试**：白名单边界、阈值边界、API 错误降级、并发多 pending

### Phase 2 — 主动推进（已上线）

实现策略：**事件驱动**而非定时器——ait.notifyTurnDone 是"session 转 idle"的天然信号，比定时轮询更省 CLI 调用。

1. `agent-supervisor.analyzeForPush()`：spawn 配置好的 CLI，让它判断 `{ done, needsHumanReview, nextPrompt, confidence, reason }`
2. 决策映射：
   - `done` + `needsHumanReview` → action='notify'，不做事，让原 Stop hook IM 通知主人验收
   - `done` 且不需要验收 → action='done'，不做事
   - 未完成 + 高置信度 + nextPrompt 非空 → action='push'，sanitize 后 `pty.write(<prompt>\r)`
   - 置信度 < threshold → action='fallback'
3. 安全闸：
   - 同 session 最大连续推进次数（默认 5）；命中后 supervisor 不再推、Stop IM 恢复推送
   - 10 分钟内无新推进则计数自然衰减回 0（避免 session 永久锁住）
   - 同一 session 两次推进间最小 5s 冷却（防 Stop hook 抖动）
   - 推进期间 `agentSupervisor.shouldSuppressStopPush` 让 openclaw-hook 静默 IM 通知，避免主人被刷屏
   - `nextPrompt` 经 `sanitizePtyInput` 清洗：剥 ANSI / 控制字符、折叠换行、截断 2000 字
4. API：
   - `POST /api/agent-supervisor/reset-push-state` 主动重置某 session 的推进计数
   - `GET /api/agent-supervisor/status` 返回 `pushStates[]` 让前端看到每个 session 已推几次
5. UI：设置面板里"主动推进"子区 + 当前 session 推进计数表 + 每行的"重置计数"按钮

### Phase 3 — 浏览器代驾（claude-in-chrome MCP 注入）

1. 全局开关 `agent.supervisor.browserControl`
2. session 启动时，把 `claude-in-chrome` 的 MCP 配置追加到 `--mcp-config` 临时文件
3. 并发：维护一把 advisory lock，同一时间只允许一个 session 拿 Chrome 控制权；其他 session 进入排队
4. Web UI：顶栏显示「🌐 浏览器当前被 #t1ab 占用」+ 强制释放按钮

## 风险点

- **判官误判**：白名单 + 阈值 + audit 是兜底；用户可以一键回滚最近一次（Phase 1 至少要做"撤销 = 给 session 发一个反向 prompt"，不要硬撤回 PTY 状态）
- **token 失控**：每条 todo 一个累计上限；超过强制叫人。CLI 路径下 token 消耗走主人订阅，不会额外扣费，但仍可能撞订阅速率限制
- **CLI 没登录 / bin 缺失**：CLI exit code 非 0 → 直接 fallback 到原流程，audit 记 `exit_<code>: <stderr>`
- **死循环**：模型卡在"还需要推进"反复回 same prompt → 检测连续相同 prompt 强制叫人
- **浏览器抢占**：Phase 3 必须有 advisory lock + UI 显示

## 验收标准（Phase 1）

- [ ] SettingsDrawer 有"代决策官"section：开关、模型、阈值、API key、Allowlist 关键词、auto for permission/ask_user 子开关
- [ ] 关掉时整套不工作（回到现有流程）
- [ ] 开启时：触发一个 Claude permission popup（如 Read 工具）→ 在 ≤5 秒内自动 Allow，前端 pending_confirm pill 自动消失
- [ ] 开启时：MCP `ask_user` 发起一个二选一问题（选项含 Yes）→ 在 ≤5 秒内自动选 Yes 并 resolve
- [ ] 不命中白名单或置信度过低 → 走原 IM 流程
- [ ] "代决策时间线"页面可以分页查看 audit
- [ ] 单测覆盖核心决策逻辑
