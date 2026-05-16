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
 * Phase 2 主动推进：分析当前 session 是否完成 + 应该给 AI 什么下一句 prompt。
 * 跟 buildDecisionPrompt（二选一）是不同的任务：这里没有候选选项，让 CLI 自己生成 nextPrompt。
 */
export function buildActivePushPrompt({ todoTitle, todoDescription, recentOutput }) {
  const parts = []
  parts.push('你正在替主人监督一个 AI session 的进展。主人离开了电脑，让你看着他的终端，你需要替他判断两件事：')
  parts.push('1. AI 是否已经把 todo 完成到可以让主人验收的程度？')
  parts.push('2. 如果还没完成，应该让 AI 接下来做什么？只能给出单行的、简短明确的下一句 prompt。')
  parts.push('')
  if (todoTitle) parts.push(`# Todo 标题\n${todoTitle}`)
  parts.push(`# Todo 描述（这是验收标准）\n${todoDescription || '(无描述，请基于标题和 AI 输出推断)'}`)
  const tail = typeof recentOutput === 'string'
    ? (recentOutput.length > 3000 ? `…${recentOutput.slice(-3000)}` : recentOutput)
    : ''
  parts.push(`# AI 最近的输出\n${tail || '(无输出)'}`)
  parts.push('')
  parts.push('只输出一行 JSON，不要 markdown 围栏：')
  parts.push('{"done": <true|false>, "needsHumanReview": <true|false>, "nextPrompt": "<单行字符串，done=true 时为空>", "confidence": <0.0-1.0>, "reason": "<一句话理由>"}')
  parts.push('')
  parts.push('规则：')
  parts.push('- 没有明显进展（AI 只输出思考、没改代码 / 没运行命令）→ done=false，nextPrompt 提示推进（"请继续"/"请运行测试"/"请把改动提交"）')
  parts.push('- AI 在等用户决策不可逆操作（删除文件、git push、改 schema、删数据库）→ done=true + needsHumanReview=true')
  parts.push('- AI 输出明显完成信号（"已完成"/"all done"/列了变更摘要） + todo 描述里的所有项都已经满足 → done=true，needsHumanReview 看场景')
  parts.push('- AI 报错卡住、无法自动恢复 → done=true + needsHumanReview=true')
  parts.push('- 不确定时给低 confidence（< 0.5）；主人会被通知验收')
  parts.push('- nextPrompt 必须单行、≤ 200 字、不要 markdown 围栏')
  return parts.join('\n')
}

export function parseActivePushResponse(text) {
  if (!text || typeof text !== 'string') return null
  let s = text.trim()
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) s = fenceMatch[1].trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first < 0 || last < 0 || last <= first) return null
  const jsonStr = s.slice(first, last + 1)
  let obj
  try { obj = JSON.parse(jsonStr) } catch { return null }
  const done = obj.done === true
  const needsHumanReview = obj.needsHumanReview === true
  const nextPrompt = typeof obj.nextPrompt === 'string' ? obj.nextPrompt : ''
  const confidence = Number(obj.confidence)
  const reason = typeof obj.reason === 'string' ? obj.reason : ''
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  return { done, needsHumanReview, nextPrompt, confidence, reason }
}

/**
 * 把 nextPrompt 清理成能安全写进 PTY 的单行串：
 *   - 剥 ANSI / 控制字符
 *   - 折叠换行成单个空格
 *   - trim 两端
 *   - 截断到 2000 字（再长 CLI 也吐不出有意义的 prompt）
 */
export function sanitizePtyInput(s) {
  if (!s || typeof s !== 'string') return ''
  let t = s
    .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  if (t.length > 2000) t = t.slice(0, 2000)
  return t
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
export function createAgentSupervisor({ db, getConfig, logger = console, runCli, now = Date.now } = {}) {
  if (!db) throw new Error('db_required')
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')

  // 每个 sessionId 的连续自动推进计数。
  // count: 已连续推进了几次；lastPushAt: 上次推进时间戳（用于自然衰减）；
  // tokens: 累计 token 估算（暂时不精确，先占位）
  // 10 分钟没有新推进 → 自然衰减回 0，避免 session 被永久锁住。
  const pushState = new Map()
  const PUSH_DECAY_MS = 10 * 60_000
  const PUSH_MIN_INTERVAL_MS = 5_000  // 同一 session 两次推进之间至少 5 秒，避免 Stop hook 抖动多推

  function getEffectivePushCount(sessionId) {
    const s = pushState.get(sessionId)
    if (!s) return 0
    if (now() - s.lastPushAt > PUSH_DECAY_MS) {
      pushState.delete(sessionId)
      return 0
    }
    return s.count
  }

  function bumpPushCount(sessionId) {
    const cur = pushState.get(sessionId) || { count: 0, lastPushAt: 0 }
    cur.count = (now() - cur.lastPushAt > PUSH_DECAY_MS ? 0 : cur.count) + 1
    cur.lastPushAt = now()
    pushState.set(sessionId, cur)
    return cur
  }

  function resetPushState(sessionId) {
    pushState.delete(sessionId)
  }

  function getPushState(sessionId) {
    const s = pushState.get(sessionId)
    if (!s) return { count: 0, lastPushAt: 0 }
    return { ...s, effectiveCount: getEffectivePushCount(sessionId) }
  }

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

  /**
   * Phase 2 主动推进：在 session 完成一轮后，问 CLI 该不该继续推、推什么。
   *
   * 返回 { action: 'push'|'notify'|'done'|'fallback'|'skipped'|'failed', nextPrompt?, reason, confidence?, state }
   *
   * 调用方（ait.notifyTurnDone 的回调）应该：
   *   - action='push'   → pty.write(sessionId, nextPrompt + '\r')，让 AI 跑下一轮
   *   - action='notify' → 不做事，等原 Stop hook IM 流程通知主人（CLI 觉得需要主人验收）
   *   - action='done'   → 不做事，等用户来看（CLI 觉得任务完成且无需验收）
   *   - 其余             → 不做事
   */
  async function analyzeForPush({ sessionId, todoId, todoTitle, todoDescription, recentOutput, cwd }) {
    const startedAt = now()
    const cfg = resolvedConfig()

    if (!cfg.enabled) return { action: 'skipped', reason: 'disabled' }
    const ap = cfg.activePush || {}
    if (!ap.enabled) return { action: 'skipped', reason: 'active_push_off' }
    if (!sessionId) return { action: 'skipped', reason: 'no_session' }

    // 同 session 限速
    const state = pushState.get(sessionId)
    if (state && now() - state.lastPushAt < PUSH_MIN_INTERVAL_MS) {
      return { action: 'skipped', reason: 'cooldown', state: getPushState(sessionId) }
    }

    // 同 session 最大连续推进次数
    const maxConsecutive = Number.isFinite(Number(ap.maxConsecutive)) ? Number(ap.maxConsecutive) : 5
    const effectiveCount = getEffectivePushCount(sessionId)
    if (effectiveCount >= maxConsecutive) {
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(max consecutive reached, skipping)', options: null,
        status: 'skipped', reason: `max_consecutive=${maxConsecutive}`,
        ms: now() - startedAt,
      })
      return { action: 'skipped', reason: 'max_consecutive_reached', state: getPushState(sessionId) }
    }

    const tool = cfg.tool || 'claude'
    let args
    try {
      args = buildSpawnArgs({ tool, model: cfg.model || '' })
    } catch (e) {
      writeAudit({ kind: 'active_push', sessionId, todoId, prompt: '(spawn args failed)', options: null, status: 'failed', reason: e.message, ms: now() - startedAt })
      return { action: 'failed', reason: e.message }
    }
    const { bin } = resolvedToolBin(tool)
    const cliPrompt = buildActivePushPrompt({ todoTitle, todoDescription, recentOutput })
    const timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 60_000

    let cliResult
    try {
      cliResult = await (runCli
        ? runCli({ tool, bin, args, prompt: cliPrompt, cwd, timeoutMs })
        : runHeadlessCli({ bin, args, prompt: cliPrompt, cwd, timeoutMs, logger }))
    } catch (e) {
      logger.warn?.(`[agent-supervisor] active push cli failed: ${e.message}`)
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(active push)', options: null,
        status: 'failed', reason: e.message || 'cli_error',
        model: cfg.model || tool, ms: now() - startedAt,
      })
      return { action: 'failed', reason: e.message || 'cli_error' }
    }

    const ms = now() - startedAt
    if (cliResult.exitCode !== 0) {
      const detail = (cliResult.stderr || '').slice(0, 300)
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(active push)', options: null,
        status: 'failed', reason: `exit_${cliResult.exitCode}: ${detail}`,
        model: cfg.model || tool, ms,
      })
      return { action: 'failed', reason: `exit_${cliResult.exitCode}` }
    }

    const parsed = parseActivePushResponse(cliResult.stdout)
    if (!parsed) {
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(active push)', options: null,
        status: 'fallback', reason: 'parse_failed',
        model: cfg.model || tool, ms,
      })
      return { action: 'fallback', reason: 'parse_failed' }
    }

    const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 0.8
    if (parsed.confidence < threshold) {
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(active push)', options: null,
        choice: parsed.done ? 'done?' : (parsed.nextPrompt || '?'),
        confidence: parsed.confidence,
        reason: `${parsed.reason} | below_threshold(${threshold})`,
        model: cfg.model || tool, ms,
        status: 'fallback',
      })
      return { action: 'fallback', reason: 'below_threshold', confidence: parsed.confidence }
    }

    if (parsed.done) {
      const action = parsed.needsHumanReview ? 'notify' : 'done'
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(active push)', options: null,
        choice: action, confidence: parsed.confidence, reason: parsed.reason,
        model: cfg.model || tool, ms,
        status: 'auto',
      })
      return { action, reason: parsed.reason, confidence: parsed.confidence }
    }

    // 推进：清洗 nextPrompt 才写 PTY；空 nextPrompt 视为模型没想好
    const cleanPrompt = sanitizePtyInput(parsed.nextPrompt)
    if (!cleanPrompt) {
      writeAudit({
        kind: 'active_push', sessionId, todoId,
        prompt: '(active push)', options: null,
        choice: 'push', confidence: parsed.confidence,
        reason: `${parsed.reason} | empty_next_prompt`,
        model: cfg.model || tool, ms,
        status: 'fallback',
      })
      return { action: 'fallback', reason: 'empty_next_prompt' }
    }

    const stateAfter = bumpPushCount(sessionId)
    writeAudit({
      kind: 'active_push', sessionId, todoId,
      prompt: '(active push)', options: null,
      choice: cleanPrompt, confidence: parsed.confidence, reason: parsed.reason,
      model: cfg.model || tool, ms,
      status: 'auto',
    })
    return {
      action: 'push',
      nextPrompt: cleanPrompt,
      reason: parsed.reason,
      confidence: parsed.confidence,
      state: { ...stateAfter, max: maxConsecutive },
    }
  }

  /**
   * 当 active push 开启且 session 还有推进 budget 时，建议 Stop hook IM 推送方静默——
   * 避免主人在 supervisor 自动迭代期间被 N 条"AI 一轮结束"刷屏。
   * 一旦 budget 耗尽（max consecutive 命中）或 active push 已经决策 notify/done/fail，
   * 这个函数返回 false，IM 推送恢复，主人收到收尾通知。
   */
  function shouldSuppressStopPush(sessionId) {
    const cfg = resolvedConfig()
    if (!cfg.enabled) return false
    if (!cfg.activePush?.enabled) return false
    if (!sessionId) return false
    const maxConsecutive = Number.isFinite(Number(cfg.activePush?.maxConsecutive)) ? Number(cfg.activePush.maxConsecutive) : 5
    const cur = getEffectivePushCount(sessionId)
    return cur < maxConsecutive
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
    // 把当前所有 session 的 push 状态摘要一并返回，UI 可以一目了然看到"哪些 session 被推过几次"
    const pushStates = []
    for (const [sid, st] of pushState.entries()) {
      pushStates.push({
        sessionId: sid,
        count: st.count,
        lastPushAt: st.lastPushAt,
        effectiveCount: getEffectivePushCount(sid),
      })
    }
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
      pushStates,
    }
  }

  return {
    decide,
    analyzeForPush,
    shouldSuppressStopPush,
    getPushState,
    resetPushState,
    describe,
    isEnabled,
    // 测试钩子
    _internals: { buildDecisionPrompt, parseDecisionResponse, isOptionInAllowlist, buildSpawnArgs, buildActivePushPrompt, parseActivePushResponse, sanitizePtyInput },
  }
}

export const __test__ = {
  buildDecisionPrompt,
  parseDecisionResponse,
  isOptionInAllowlist,
  buildSpawnArgs,
  buildActivePushPrompt,
  parseActivePushResponse,
  sanitizePtyInput,
}
