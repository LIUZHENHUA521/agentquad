/**
 * Agent Supervisor（守望者）—— C 方案核心。
 *
 * 关键：不调 Anthropic API（主人没买 API key）。用主人已经装好并登录的本地 CLI——
 * claude / codex / cursor-agent——以 headless 模式（-p / exec）做判断。
 * 这样所有 token 消耗都走主人现有的订阅，不会额外扣费。
 *
 * 三个职责（Phase 1 只接 1）：
 *   1) 自动决策官：session 卡在权限弹窗 / ask_user 时，跑一次 CLI 让它在选项里挑一个
 *   2) 主动推进（Phase 2）：定时器扫所有 running/idle session，给 idle 的喂下一句 prompt
 *   3) 浏览器代驾（Phase 3）：注入 claude-in-chrome MCP
 *
 * 安全模型：
 *   - 全局开关 disabled → 全部跳过
 *   - 白名单：CLI 返回的选项必须命中 allowlist 关键词（小写匹配），否则拒绝
 *   - 置信度阈值：CLI 自报 confidence < threshold → 拒绝
 *   - CLI 报错 / 超时 → fallback 到原流程，不阻塞
 *   - 每次决策都写 agent_decisions（status: 'auto'|'fallback'|'failed'|'skipped'）
 *
 * 决策接口：让 CLI 以 JSON 文本回 `{ choiceIndex, choice, confidence (0-1), reason }`。
 * 我们用极简 prompt 强约束格式 + 容错解析。
 */
import { spawn } from 'node:child_process'
import { resolveToolsConfig } from './config.js'

// 单 prompt 内的"换行 + 围栏"会让 CLI 误以为是用户在 demo markdown。
// 用普通空行分段就够了，不要 ``` 包裹。

/**
 * 选项匹配 allowlist：option 文本 lower-case 后只要 includes 任一关键词就放行。
 * 这是"安全护栏"，不是 fuzzy matching —— CLI 选什么由 CLI 决定，我们这里只挡掉
 * 危险选项（Deny / Cancel / 复杂 free text）。
 */
export function isOptionInAllowlist(option, allowlist) {
  if (!option || typeof option !== 'string') return false
  const s = option.trim().toLowerCase()
  if (!s) return false
  return allowlist.some((kw) => s.includes(String(kw || '').trim().toLowerCase()))
}

/**
 * 构造给 CLI 的 prompt。
 *
 * 所有 CLI 都是 markdown 友好 + 都能吃 stdin，所以一份模板通吃。
 */
export function buildDecisionPrompt({ kind, todoTitle, todoDescription, promptText, options, recentOutput }) {
  const optionList = options.map((opt, i) => `  ${i}. ${opt}`).join('\n')
  const ctxParts = []
  if (todoTitle) ctxParts.push(`# Todo 标题\n${todoTitle}`)
  if (todoDescription) ctxParts.push(`# Todo 描述\n${todoDescription}`)
  if (recentOutput) {
    const tail = recentOutput.length > 1500 ? `…${recentOutput.slice(-1500)}` : recentOutput
    ctxParts.push(`# 最近的 session 输出（尾部）\n${tail}`)
  }
  ctxParts.push(`# 当前等待的提示\n${promptText || '(no prompt text)'}`)
  ctxParts.push(`# 候选选项\n${optionList || '(no options)'}`)
  ctxParts.push(`# 决策类型\n${kind}（permission=PTY 权限弹窗，ask_user=AI 主动问用户，active_push=主动推进）`)

  return [
    '你正在替主人做一个二选一的决策——主人离开了电脑，让你看着他的 AI 终端 session。当 session 卡在等输入时，你需要在已有选项中挑一个，让 session 能继续往下走。',
    '',
    ctxParts.join('\n\n'),
    '',
    '只输出一行 JSON，不要 markdown 围栏、不要解释文字：',
    '{"choiceIndex": <0-based int>, "choice": "<exact option text>", "confidence": <0.0-1.0>, "reason": "<一句话理由>"}',
    '',
    '规则：',
    '- 如果你不确定，或涉及破坏性 / 不可逆操作（删除、推送、改 schema、改公共 API），confidence 必须 < 0.5',
    '- 如果用户的 todo 描述明确允许 / 期望某个动作（例如"按自动驾驶模式"），可以更激进',
    '- 永远只在已有选项中挑一个，不要发明新选项',
  ].join('\n')
}

/**
 * 解析 CLI 回复。CLI 偶尔会带 ```json 围栏或者引号问题，我们容错处理。
 */
export function parseDecisionResponse(text, options) {
  if (!text || typeof text !== 'string') return null
  let s = text.trim()
  // 剥 markdown 围栏（CLI 经常无视"别围栏"的指令）
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) s = fenceMatch[1].trim()
  // 取第一个 { 到最后一个 }
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first < 0 || last < 0 || last <= first) return null
  const jsonStr = s.slice(first, last + 1)
  let obj
  try { obj = JSON.parse(jsonStr) } catch { return null }
  const choiceIndex = Number.isInteger(obj.choiceIndex) ? obj.choiceIndex : null
  const confidence = Number(obj.confidence)
  const reason = typeof obj.reason === 'string' ? obj.reason : ''
  if (choiceIndex === null || choiceIndex < 0 || choiceIndex >= options.length) return null
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  return {
    choiceIndex,
    choice: options[choiceIndex],
    confidence,
    reason,
  }
}

/**
 * 解析 tool 配置 → 决定怎么 spawn。
 *
 * 三个工具的 headless 模式（实测于 Codex 0.124 / Cursor agent / Claude Code latest）：
 *   - claude:        `<bin> -p --output-format text [--model X]`，prompt 走 stdin
 *   - codex:         `<bin> exec [--model X]`，prompt 走 stdin
 *   - cursor:        `<bin> -p --output-format text [--model X]`，prompt 走 stdin
 *
 * 所有 CLI 都接受 stdin，所以我们统一从 stdin 喂 prompt（最干净，不会因为 prompt 里
 * 含特殊字符把 shell 整坏）。
 */
export function buildSpawnArgs({ tool, model }) {
  switch (tool) {
    case 'claude':
      return ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])]
    case 'codex':
      return ['exec', ...(model ? ['--model', model] : [])]
    case 'cursor':
      return ['-p', '--output-format', 'text', ...(model ? ['--model', model] : [])]
    default:
      throw new Error(`unknown_supervisor_tool:${tool}`)
  }
}

/**
 * spawn 本地 CLI 跑一次 headless 决策。
 *
 * 返回 { stdout, stderr, exitCode, durationMs }。
 * timeout → 抛 Error('cli_timeout')；spawn 失败 → 抛 ENOENT 等。
 */
async function runHeadlessCli({ bin, args, prompt, cwd, timeoutMs, logger }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return reject(e)
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      reject(new Error('cli_timeout'))
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - startedAt })
    })
    try {
      child.stdin.write(prompt)
      child.stdin.end()
    } catch (e) {
      logger?.warn?.(`[agent-supervisor] write stdin failed: ${e.message}`)
      try { child.kill('SIGTERM') } catch {}
      reject(e)
    }
  })
}

/**
 * 守望者工厂。
 *
 * deps:
 *   - db: openDb() 返回的实例
 *   - getConfig: () => loadConfig()
 *   - logger
 *   - runCli: 测试注入用，签名 = ({ bin, args, prompt, cwd, timeoutMs }) => Promise<{stdout, stderr, exitCode}>
 */
export function createAgentSupervisor({ db, getConfig, logger = console, runCli } = {}) {
  if (!db) throw new Error('db_required')
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')

  function resolvedConfig() {
    const cfg = getConfig() || {}
    return cfg.agentSupervisor || {}
  }

  function resolvedToolBin(tool) {
    const cfg = getConfig() || {}
    const tools = resolveToolsConfig(cfg.tools || {})
    const meta = tools[tool]
    if (!meta) return { command: tool, bin: '' }
    return { command: meta.command || tool, bin: meta.bin || meta.command || tool }
  }

  function isEnabled() {
    return !!resolvedConfig().enabled
  }

  /**
   * 给定一个 pending（permission / ask_user / active_push），决定是否自动处理。
   * 返回：
   *   - { status: 'skipped', reason }    — 全局关 / 类型未启用 / 选项不在白名单
   *   - { status: 'auto', choice, choiceIndex, confidence, reason } — 通过，调用方应该提交这个回复
   *   - { status: 'fallback', reason, confidence? } — CLI 置信度低 / 解析失败，走原流程
   *   - { status: 'failed', reason }     — CLI 错误 / 超时
   *
   * 任何 status 都会写 agent_decisions（除非 status=skipped 且 reason='disabled'）。
   */
  async function decide({ kind, sessionId, todoId, todoTitle, todoDescription, promptText, options, recentOutput, cwd }) {
    const startedAt = Date.now()
    const cfg = resolvedConfig()

    // 全局开关
    if (!cfg.enabled) {
      return { status: 'skipped', reason: 'disabled' }
    }
    if (kind === 'permission' && !cfg.permissionAuto) {
      writeAudit({ kind, sessionId, todoId, prompt: promptText, options, status: 'skipped', reason: 'permission_auto_off', ms: Date.now() - startedAt })
      return { status: 'skipped', reason: 'permission_auto_off' }
    }
    if (kind === 'ask_user' && !cfg.askUserAuto) {
      writeAudit({ kind, sessionId, todoId, prompt: promptText, options, status: 'skipped', reason: 'ask_user_auto_off', ms: Date.now() - startedAt })
      return { status: 'skipped', reason: 'ask_user_auto_off' }
    }
    if (!Array.isArray(options) || options.length === 0) {
      writeAudit({ kind, sessionId, todoId, prompt: promptText, options, status: 'skipped', reason: 'no_options', ms: Date.now() - startedAt })
      return { status: 'skipped', reason: 'no_options' }
    }

    const tool = cfg.tool || 'claude'
    let args
    try {
      args = buildSpawnArgs({ tool, model: cfg.model || '' })
    } catch (e) {
      writeAudit({ kind, sessionId, todoId, prompt: promptText, options, status: 'failed', reason: e.message, ms: Date.now() - startedAt })
      return { status: 'failed', reason: e.message }
    }
    const { bin } = resolvedToolBin(tool)
    const cliPrompt = buildDecisionPrompt({ kind, todoTitle, todoDescription, promptText, options, recentOutput })
    const timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 60_000

    let cliResult
    try {
      cliResult = await (runCli
        ? runCli({ tool, bin, args, prompt: cliPrompt, cwd, timeoutMs })
        : runHeadlessCli({ bin, args, prompt: cliPrompt, cwd, timeoutMs, logger }))
    } catch (e) {
      logger.warn?.(`[agent-supervisor] cli run failed (tool=${tool}, bin=${bin}): ${e.message}`)
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        status: 'failed', reason: e.message || 'cli_error',
        model: cfg.model || tool, ms: Date.now() - startedAt,
      })
      return { status: 'failed', reason: e.message || 'cli_error' }
    }

    const ms = Date.now() - startedAt

    if (cliResult.exitCode !== 0) {
      const detail = (cliResult.stderr || '').slice(0, 300)
      logger.warn?.(`[agent-supervisor] cli non-zero exit ${cliResult.exitCode} tool=${tool}: ${detail}`)
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        status: 'failed', reason: `exit_${cliResult.exitCode}: ${detail}`,
        model: cfg.model || tool, ms,
      })
      return { status: 'failed', reason: `exit_${cliResult.exitCode}` }
    }

    const parsed = parseDecisionResponse(cliResult.stdout, options)
    if (!parsed) {
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        choice: null, confidence: null, reason: 'parse_failed_or_invalid_index',
        model: cfg.model || tool, ms,
        status: 'fallback',
      })
      return { status: 'fallback', reason: 'parse_failed' }
    }

    // 白名单：选中的 option 必须命中关键词
    if (!isOptionInAllowlist(parsed.choice, cfg.allowlist || [])) {
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        choice: parsed.choice, confidence: parsed.confidence, reason: `${parsed.reason} | not_in_allowlist`,
        model: cfg.model || tool, ms,
        status: 'fallback',
      })
      return { status: 'fallback', reason: 'not_in_allowlist', confidence: parsed.confidence }
    }

    // 阈值检查
    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 0.8
    if (parsed.confidence < threshold) {
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        choice: parsed.choice, confidence: parsed.confidence, reason: `${parsed.reason} | below_threshold(${threshold})`,
        model: cfg.model || tool, ms,
        status: 'fallback',
      })
      return { status: 'fallback', reason: 'below_threshold', confidence: parsed.confidence }
    }

    // 通过
    writeAudit({
      kind, sessionId, todoId,
      prompt: promptText, options,
      choice: parsed.choice, confidence: parsed.confidence, reason: parsed.reason,
      model: cfg.model || tool, ms,
      status: 'auto',
    })
    return {
      status: 'auto',
      choice: parsed.choice,
      choiceIndex: parsed.choiceIndex,
      confidence: parsed.confidence,
      reason: parsed.reason,
    }
  }

  function writeAudit(row) {
    try {
      db.insertAgentDecision(row)
    } catch (e) {
      logger.warn?.(`[agent-supervisor] write audit failed: ${e.message}`)
    }
  }

  function describe() {
    const cfg = resolvedConfig()
    const tool = cfg.tool || 'claude'
    const { command, bin } = resolvedToolBin(tool)
    return {
      enabled: !!cfg.enabled,
      tool,
      command,
      bin,                       // 让 UI 能展示"将执行 /usr/local/bin/claude"，方便排查
      model: cfg.model || '',
      timeoutMs: cfg.timeoutMs,
      threshold: cfg.threshold,
      allowlist: cfg.allowlist,
      permissionAuto: !!cfg.permissionAuto,
      askUserAuto: !!cfg.askUserAuto,
      activePush: cfg.activePush || {},
      browserControl: cfg.browserControl || {},
    }
  }

  return {
    decide,
    describe,
    isEnabled,
    // 测试钩子
    _internals: { buildDecisionPrompt, parseDecisionResponse, isOptionInAllowlist, buildSpawnArgs },
  }
}

export const __test__ = {
  buildDecisionPrompt,
  parseDecisionResponse,
  isOptionInAllowlist,
  buildSpawnArgs,
}
