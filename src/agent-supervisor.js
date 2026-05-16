/**
 * Agent Supervisor（守望者）—— C 方案核心。
 *
 * 三个职责（Phase 1 只接 1）：
 *   1) 自动决策官：session 卡在权限弹窗 / ask_user 时，调 Claude Opus 4.7 在选项里挑一个
 *   2) 主动推进（Phase 2）：定时器扫所有 running/idle session，给 idle 的喂下一句 prompt
 *   3) 浏览器代驾（Phase 3）：注入 claude-in-chrome MCP
 *
 * 安全模型：
 *   - 全局开关 disabled → 全部跳过，回到现有 IM / 用户手动流程
 *   - 白名单：模型选项必须命中 allowlist 关键词（小写匹配），否则拒绝
 *   - 置信度阈值：模型自报 confidence < threshold → 拒绝
 *   - 模型出错 / 超时 → fallback 到原流程，不阻塞
 *   - 每次决策都写 agent_decisions（status: 'auto'|'fallback'|'failed'|'skipped'）
 *
 * 决策接口：模型必须以 JSON 返回 `{ choiceIndex, choice, confidence (0-1), reason }`。
 * 我们用 system prompt 强约束输出格式 + responseFormat 解析降级。
 */

const ENV_API_KEY = 'ANTHROPIC_API_KEY'

function maskKey(k) {
  if (!k || typeof k !== 'string') return ''
  if (k.length <= 8) return '***'
  return `${k.slice(0, 4)}…${k.slice(-4)}`
}

/**
 * 选项匹配 allowlist：option 文本 lower-case 后只要 includes 任一关键词就放行。
 * 这是"安全护栏"，而不是 fuzzy matching —— 模型最终选什么由 model 决定，
 * 我们这里只挡掉危险选项（Deny / Cancel / 复杂 free text）。
 */
export function isOptionInAllowlist(option, allowlist) {
  if (!option || typeof option !== 'string') return false
  const s = option.trim().toLowerCase()
  if (!s) return false
  return allowlist.some((kw) => s.includes(String(kw || '').trim().toLowerCase()))
}

/**
 * 构造调用 Anthropic Messages API 的 payload。
 *
 * Prompt 设计要点：
 *   - 极简 system prompt，明确"只输出 JSON"
 *   - 把 todo 上下文（title/description）+ 当前 prompt + 选项打包成 user message
 *   - 选项编号从 0 开始（跟 chosenIndex 一致）
 *   - 加一段强约束："如果不确定 / 涉及破坏性操作，confidence < 0.5"
 */
export function buildDecisionPayload({ kind, model, todoTitle, todoDescription, promptText, options, recentOutput }) {
  const optionList = options.map((opt, i) => `  ${i}. ${opt}`).join('\n')
  const ctxParts = []
  if (todoTitle) ctxParts.push(`# Todo 标题\n${todoTitle}`)
  if (todoDescription) ctxParts.push(`# Todo 描述\n${todoDescription}`)
  if (recentOutput) {
    const tail = recentOutput.length > 1500 ? `…${recentOutput.slice(-1500)}` : recentOutput
    ctxParts.push(`# 最近的 session 输出（尾部）\n\`\`\`\n${tail}\n\`\`\``)
  }
  ctxParts.push(`# 当前等待的提示\n${promptText || '(no prompt text)'}`)
  ctxParts.push(`# 候选选项\n${optionList || '(no options)'}`)
  ctxParts.push(`# 决策类型\n${kind}（permission=PTY 权限弹窗，ask_user=AI 主动问用户，active_push=主动推进）`)

  const userMessage = ctxParts.join('\n\n') + `\n\n请基于以上信息选一个选项，输出严格 JSON：\n{"choiceIndex": <0-based int>, "choice": "<exact option text>", "confidence": <0.0-1.0>, "reason": "<一句话理由>"}\n\n规则：\n- 如果你不确定或涉及破坏性 / 不可逆操作（删除、推送、改 schema、改公共 API），confidence 必须 < 0.5\n- 如果用户的 todo 描述里明确允许 / 期望某个动作（例如"按自动驾驶模式"），可以更激进\n- 只输出 JSON，不要 markdown 围栏、不要任何解释文字`

  return {
    model,
    max_tokens: 256,
    system: '你是 AgentQuad 的守望者，替用户在 AI 终端 session 卡住等输入时做决策。你的回复必须是单一 JSON 对象，没有任何额外文字。',
    messages: [
      { role: 'user', content: userMessage },
    ],
  }
}

/**
 * 解析模型回复。模型偶尔会带 ```json 围栏或者引号问题，我们容错处理。
 */
export function parseDecisionResponse(text, options) {
  if (!text || typeof text !== 'string') return null
  let s = text.trim()
  // 剥 markdown 围栏
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
 * 调 Anthropic Messages API。fetch 用 Node 20+ 内置 global fetch。
 * 错误：抛出 Error，由 caller 走 fallback。
 */
async function callAnthropic({ apiKey, apiBaseUrl, payload, timeoutMs = 30_000, logger = console }) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) {
      logger.warn?.(`[agent-supervisor] anthropic api ${res.status}: ${body.slice(0, 400)}`)
      throw new Error(`anthropic_api_${res.status}`)
    }
    let parsed
    try { parsed = JSON.parse(body) } catch (e) { throw new Error('anthropic_api_invalid_json') }
    const textBlock = (parsed.content || []).find((b) => b?.type === 'text')
    return {
      text: textBlock?.text || '',
      usage: parsed.usage || {},
    }
  } finally {
    clearTimeout(t)
  }
}

/**
 * 守望者工厂。
 *
 * deps:
 *   - db: openDb() 返回的实例
 *   - getConfig: () => loadConfig()
 *   - logger
 *   - fetchImpl: 测试注入用
 */
export function createAgentSupervisor({ db, getConfig, logger = console, fetchImpl } = {}) {
  if (!db) throw new Error('db_required')
  if (typeof getConfig !== 'function') throw new Error('getConfig_required')

  function resolvedConfig() {
    const cfg = getConfig() || {}
    return cfg.agentSupervisor || {}
  }

  function effectiveApiKey() {
    const cfg = resolvedConfig()
    const fromCfg = (cfg.apiKey || '').trim()
    if (fromCfg && !fromCfg.includes('…')) return fromCfg
    return (process.env[ENV_API_KEY] || '').trim()
  }

  function isEnabled() {
    return !!resolvedConfig().enabled && !!effectiveApiKey()
  }

  /**
   * 给定一个 pending（permission / ask_user / active_push），决定是否自动处理。
   * 返回：
   *   - { status: 'skipped', reason }    — 全局关 / 类型未启用 / 选项不在白名单
   *   - { status: 'auto', choice, choiceIndex, confidence, reason } — 通过，调用方应该提交这个回复
   *   - { status: 'fallback', reason, confidence? } — 模型置信度低 / 解析失败，走原流程
   *   - { status: 'failed', reason }     — API 错误 / 超时
   *
   * 任何 status 都会写 agent_decisions（除非 status=skipped 且 reason='disabled'）。
   */
  async function decide({ kind, sessionId, todoId, todoTitle, todoDescription, promptText, options, recentOutput }) {
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

    const apiKey = effectiveApiKey()
    if (!apiKey) {
      writeAudit({ kind, sessionId, todoId, prompt: promptText, options, status: 'failed', reason: 'no_api_key', ms: Date.now() - startedAt })
      return { status: 'failed', reason: 'no_api_key' }
    }

    const payload = buildDecisionPayload({
      kind,
      model: cfg.model || 'claude-opus-4-7',
      todoTitle,
      todoDescription,
      promptText,
      options,
      recentOutput,
    })

    let apiResult
    try {
      apiResult = await (fetchImpl ? fetchImpl({ apiKey, apiBaseUrl: cfg.apiBaseUrl, payload }) : callAnthropic({ apiKey, apiBaseUrl: cfg.apiBaseUrl, payload, logger }))
    } catch (e) {
      logger.warn?.(`[agent-supervisor] api call failed: ${e.message}`)
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        status: 'failed', reason: e.message || 'api_error',
        model: cfg.model, ms: Date.now() - startedAt,
      })
      return { status: 'failed', reason: e.message || 'api_error' }
    }

    const parsed = parseDecisionResponse(apiResult.text, options)
    const ms = Date.now() - startedAt
    const tokensIn = Number.isInteger(apiResult.usage?.input_tokens) ? apiResult.usage.input_tokens : null
    const tokensOut = Number.isInteger(apiResult.usage?.output_tokens) ? apiResult.usage.output_tokens : null

    if (!parsed) {
      writeAudit({
        kind, sessionId, todoId,
        prompt: promptText, options,
        choice: null, confidence: null, reason: 'parse_failed_or_invalid_index',
        model: cfg.model, tokensIn, tokensOut, ms,
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
        model: cfg.model, tokensIn, tokensOut, ms,
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
        model: cfg.model, tokensIn, tokensOut, ms,
        status: 'fallback',
      })
      return { status: 'fallback', reason: 'below_threshold', confidence: parsed.confidence }
    }

    // 通过
    writeAudit({
      kind, sessionId, todoId,
      prompt: promptText, options,
      choice: parsed.choice, confidence: parsed.confidence, reason: parsed.reason,
      model: cfg.model, tokensIn, tokensOut, ms,
      status: 'auto',
    })
    return {
      status: 'auto',
      choice: parsed.choice,
      choiceIndex: parsed.choiceIndex,
      confidence: parsed.confidence,
      reason: parsed.reason,
      tokensIn,
      tokensOut,
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
    const apiKey = effectiveApiKey()
    return {
      enabled: !!cfg.enabled,
      hasApiKey: !!apiKey,
      apiKeyHint: maskKey(apiKey),
      model: cfg.model,
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
    _internals: { buildDecisionPayload, parseDecisionResponse, isOptionInAllowlist, maskKey },
  }
}

export const __test__ = {
  buildDecisionPayload,
  parseDecisionResponse,
  isOptionInAllowlist,
  maskKey,
}
