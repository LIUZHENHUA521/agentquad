import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import { createAgentSupervisor, __test__ } from '../src/agent-supervisor.js'

const { buildDecisionPrompt, parseDecisionResponse, isOptionInAllowlist, buildSpawnArgs, buildActivePushPrompt, parseActivePushResponse, sanitizePtyInput } = __test__

describe('agent-supervisor / utilities', () => {
  it('isOptionInAllowlist matches case-insensitively and via includes', () => {
    expect(isOptionInAllowlist('Allow once', ['allow'])).toBe(true)
    expect(isOptionInAllowlist('Yes, do it', ['yes'])).toBe(true)
    expect(isOptionInAllowlist('Deny', ['allow', 'yes'])).toBe(false)
    expect(isOptionInAllowlist('', ['allow'])).toBe(false)
    expect(isOptionInAllowlist('Allow', [])).toBe(false)
  })

  it('parseDecisionResponse handles fenced JSON, plain JSON, and rejects invalid', () => {
    const options = ['Allow', 'Deny']
    expect(parseDecisionResponse('```json\n{"choiceIndex":0,"choice":"Allow","confidence":0.9,"reason":"ok"}\n```', options))
      .toMatchObject({ choiceIndex: 0, choice: 'Allow', confidence: 0.9, reason: 'ok' })
    expect(parseDecisionResponse('{"choiceIndex":1,"choice":"Deny","confidence":0.4,"reason":"meh"}', options))
      .toMatchObject({ choiceIndex: 1, confidence: 0.4 })
    expect(parseDecisionResponse('garbage', options)).toBeNull()
    // out of range
    expect(parseDecisionResponse('{"choiceIndex":5,"confidence":0.9}', options)).toBeNull()
    // bad confidence
    expect(parseDecisionResponse('{"choiceIndex":0,"confidence":2}', options)).toBeNull()
  })

  it('buildDecisionPrompt includes context + options + JSON instructions', () => {
    const p = buildDecisionPrompt({
      kind: 'permission',
      todoTitle: '部署服务',
      todoDescription: '提了 PR 之后部署上线',
      promptText: 'Do you want to run `git push`?',
      options: ['Allow', 'Allow once', 'Deny'],
      recentOutput: 'about to push',
    })
    expect(p).toContain('部署服务')
    expect(p).toContain('Allow once')
    expect(p).toContain('JSON')
  })

  it('buildSpawnArgs returns CLI-specific flags', () => {
    expect(buildSpawnArgs({ tool: 'claude' })).toEqual(['-p', '--output-format', 'text'])
    expect(buildSpawnArgs({ tool: 'claude', model: 'claude-opus-4-7' }))
      .toEqual(['-p', '--output-format', 'text', '--model', 'claude-opus-4-7'])
    expect(buildSpawnArgs({ tool: 'codex' })).toEqual(['exec'])
    expect(buildSpawnArgs({ tool: 'codex', model: 'gpt-5' }))
      .toEqual(['exec', '--model', 'gpt-5'])
    expect(buildSpawnArgs({ tool: 'cursor' })).toEqual(['-p', '--output-format', 'text'])
    expect(() => buildSpawnArgs({ tool: 'unknown' })).toThrow(/unknown_supervisor_tool/)
  })
})

describe('agent-supervisor / decide()', () => {
  let db
  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo?.({ id: 't1', title: '部署服务', description: '提 PR 之后上线', quadrant: 1 })
  })

  function makeSupervisor({
    enabled = true,
    allowlist = ['allow', 'yes'],
    threshold = 0.8,
    tool = 'claude',
    model = '',
    runCli,
    permissionAuto = true,
    askUserAuto = true,
    timeoutMs = 60_000,
  } = {}) {
    return createAgentSupervisor({
      db,
      getConfig: () => ({
        tools: { claude: { command: 'claude', bin: '/usr/local/bin/claude', args: [] }, codex: { command: 'codex', bin: '/usr/local/bin/codex', args: [] }, cursor: { command: 'cursor-agent', bin: '/usr/local/bin/cursor-agent', args: [] } },
        agentSupervisor: {
          enabled, tool, model, timeoutMs,
          threshold, allowlist, permissionAuto, askUserAuto,
          activePush: {}, browserControl: {},
        },
      }),
      logger: { warn: () => {}, info: () => {} },
      runCli,
    })
  }

  it('returns skipped when disabled and writes no audit', async () => {
    const sup = makeSupervisor({ enabled: false })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
    expect(r).toEqual({ status: 'skipped', reason: 'disabled' })
    expect(db.countAgentDecisions()).toBe(0)
  })

  it('passes spawn args + prompt to CLI runner', async () => {
    let captured = null
    const sup = makeSupervisor({
      tool: 'claude',
      model: 'claude-opus-4-7',
      runCli: async (args) => {
        captured = args
        return { stdout: '{"choiceIndex":0,"choice":"Allow","confidence":0.95,"reason":"safe"}', stderr: '', exitCode: 0 }
      },
    })
    await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'read file?', options: ['Allow', 'Deny'], cwd: '/tmp' })
    expect(captured.tool).toBe('claude')
    expect(captured.bin).toBe('/usr/local/bin/claude')
    expect(captured.args).toEqual(['-p', '--output-format', 'text', '--model', 'claude-opus-4-7'])
    expect(captured.cwd).toBe('/tmp')
    expect(captured.timeoutMs).toBe(60_000)
    expect(captured.prompt).toContain('read file?')
    expect(captured.prompt).toContain('Allow')
  })

  it('returns auto when CLI returns confident in-allowlist choice', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({
        stdout: '{"choiceIndex":0,"choice":"Allow","confidence":0.95,"reason":"safe read"}',
        stderr: '', exitCode: 0,
      }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'read file?', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('auto')
    expect(r.choice).toBe('Allow')
    expect(r.confidence).toBe(0.95)
    expect(db.countAgentDecisions()).toBe(1)
    const rows = db.listAgentDecisions({ limit: 10 })
    expect(rows[0].status).toBe('auto')
  })

  it('falls back when option not in allowlist', async () => {
    const sup = makeSupervisor({
      allowlist: ['allow'],
      runCli: async () => ({ stdout: '{"choiceIndex":1,"choice":"Deny","confidence":0.99,"reason":"danger"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'delete?', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('fallback')
    expect(r.reason).toBe('not_in_allowlist')
    expect(db.countAgentDecisions()).toBe(1)
  })

  it('falls back when confidence below threshold', async () => {
    const sup = makeSupervisor({
      threshold: 0.9,
      runCli: async () => ({ stdout: '{"choiceIndex":0,"choice":"Allow","confidence":0.6,"reason":"maybe"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('fallback')
    expect(r.reason).toBe('below_threshold')
  })

  it('returns failed on CLI non-zero exit and writes audit', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: '', stderr: 'login required', exitCode: 1 }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
    expect(r.status).toBe('failed')
    expect(r.reason).toMatch(/exit_1/)
    expect(db.countAgentDecisions()).toBe(1)
    expect(db.listAgentDecisions({ limit: 1 })[0].status).toBe('failed')
  })

  it('returns failed on CLI throw (ENOENT / timeout)', async () => {
    const sup = makeSupervisor({
      runCli: async () => { throw new Error('cli_timeout') },
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
    expect(r.status).toBe('failed')
    expect(r.reason).toBe('cli_timeout')
  })

  it('respects permissionAuto sub-toggle', async () => {
    const sup = makeSupervisor({ permissionAuto: false })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
    expect(r.status).toBe('skipped')
    expect(r.reason).toBe('permission_auto_off')
    expect(db.countAgentDecisions()).toBe(1)
  })

  it('respects askUserAuto sub-toggle', async () => {
    const sup = makeSupervisor({ askUserAuto: false })
    const r = await sup.decide({ kind: 'ask_user', sessionId: 's1', todoId: null, promptText: 'p', options: ['Yes'] })
    expect(r.status).toBe('skipped')
    expect(r.reason).toBe('ask_user_auto_off')
  })

  it('uses codex spawn args when tool=codex', async () => {
    let captured = null
    const sup = makeSupervisor({
      tool: 'codex',
      runCli: async (args) => {
        captured = args
        return { stdout: '{"choiceIndex":0,"choice":"Allow","confidence":0.9,"reason":"x"}', stderr: '', exitCode: 0 }
      },
    })
    await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow', 'Deny'] })
    expect(captured.tool).toBe('codex')
    expect(captured.args).toEqual(['exec'])
    expect(captured.bin).toBe('/usr/local/bin/codex')
  })

  it('falls back on unparseable CLI output', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: 'I think you should allow this', stderr: '', exitCode: 0 }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('fallback')
    expect(r.reason).toBe('parse_failed')
  })
})

describe('agent-supervisor / Phase 2 utilities', () => {
  it('sanitizePtyInput strips control chars + collapses newlines + trims + truncates', () => {
    expect(sanitizePtyInput('  hello\n\nworld  ')).toBe('hello world')
    expect(sanitizePtyInput('\x1b[31mred\x1b[0m text')).toBe('red text')
    expect(sanitizePtyInput('a'.repeat(2500)).length).toBe(2000)
    expect(sanitizePtyInput('')).toBe('')
    expect(sanitizePtyInput(null)).toBe('')
  })

  it('buildActivePushPrompt embeds todo + recent output + JSON spec', () => {
    const p = buildActivePushPrompt({
      todoTitle: '部署服务',
      todoDescription: '提了 PR 之后部署上线',
      recentOutput: 'AI: I will run gh pr view',
    })
    expect(p).toContain('部署服务')
    expect(p).toContain('gh pr view')
    expect(p).toContain('"done"')
    expect(p).toContain('单行')
  })

  it('parseActivePushResponse handles JSON / fenced / rejects invalid', () => {
    expect(parseActivePushResponse('{"done":false,"needsHumanReview":false,"nextPrompt":"请继续","confidence":0.9,"reason":"AI 卡在思考"}'))
      .toMatchObject({ done: false, nextPrompt: '请继续', confidence: 0.9 })
    expect(parseActivePushResponse('```json\n{"done":true,"needsHumanReview":true,"nextPrompt":"","confidence":0.95,"reason":"等用户确认 push"}\n```'))
      .toMatchObject({ done: true, needsHumanReview: true })
    expect(parseActivePushResponse('garbage')).toBeNull()
    expect(parseActivePushResponse('{"done":false,"confidence":2}')).toBeNull()
  })
})

describe('agent-supervisor / analyzeForPush()', () => {
  let db
  beforeEach(() => {
    db = openDb(':memory:')
  })

  function makeSupervisor({
    enabled = true,
    activePushEnabled = true,
    maxConsecutive = 5,
    threshold = 0.8,
    runCli,
    now,
  } = {}) {
    return createAgentSupervisor({
      db,
      now: now || Date.now,
      getConfig: () => ({
        tools: { claude: { command: 'claude', bin: '/usr/local/bin/claude', args: [] } },
        agentSupervisor: {
          enabled, tool: 'claude', model: '', timeoutMs: 60_000,
          threshold, allowlist: ['allow', 'yes'],
          permissionAuto: true, askUserAuto: true,
          activePush: { enabled: activePushEnabled, maxConsecutive, intervalMs: 60_000, maxTokensPerTodo: 500_000 },
          browserControl: {},
        },
      }),
      logger: { warn: () => {}, info: () => {} },
      runCli,
    })
  }

  it('returns skipped when globally disabled', async () => {
    const sup = makeSupervisor({ enabled: false })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('disabled')
  })

  it('returns skipped when active push sub-toggle off', async () => {
    const sup = makeSupervisor({ activePushEnabled: false })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('active_push_off')
  })

  it('returns push action with sanitized prompt + bumps counter', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"请\\n继续","confidence":0.9,"reason":"AI 在思考"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: 't1', todoTitle: 'X', recentOutput: 'thinking' })
    expect(r.action).toBe('push')
    expect(r.nextPrompt).toBe('请 继续')
    expect(r.state.count).toBe(1)
    expect(sup.getPushState('s1').count).toBe(1)
  })

  it('returns notify action when done + needsHumanReview', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: '{"done":true,"needsHumanReview":true,"nextPrompt":"","confidence":0.95,"reason":"等用户验收 PR push"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('notify')
  })

  it('returns done action when done + !needsHumanReview', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: '{"done":true,"needsHumanReview":false,"nextPrompt":"","confidence":0.9,"reason":"已搞定"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('done')
  })

  it('falls back when below threshold', async () => {
    const sup = makeSupervisor({
      threshold: 0.9,
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"请继续","confidence":0.5,"reason":"猜"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('fallback')
    expect(r.reason).toBe('below_threshold')
  })

  it('falls back when nextPrompt is empty after sanitize', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"  ","confidence":0.95,"reason":"想推但没想好"}', stderr: '', exitCode: 0 }),
    })
    const r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('fallback')
    expect(r.reason).toBe('empty_next_prompt')
  })

  it('skips when max consecutive reached and stays skipped on retries', async () => {
    let nowMs = 1_000_000
    const sup = makeSupervisor({
      maxConsecutive: 2,
      now: () => nowMs,
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"继续","confidence":0.95,"reason":""}', stderr: '', exitCode: 0 }),
    })
    nowMs += 10_000
    let r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('push')
    nowMs += 10_000
    r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('push')
    nowMs += 10_000
    r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('max_consecutive_reached')
  })

  it('skips when last push happened within cooldown', async () => {
    let nowMs = 1_000_000
    const sup = makeSupervisor({
      now: () => nowMs,
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"继续","confidence":0.95,"reason":""}', stderr: '', exitCode: 0 }),
    })
    nowMs += 10_000
    let r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('push')
    nowMs += 1_000   // 仍在 5_000ms 冷却内
    r = await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(r.action).toBe('skipped')
    expect(r.reason).toBe('cooldown')
  })

  it('resets push state explicitly via resetPushState', async () => {
    const sup = makeSupervisor({
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"继续","confidence":0.95,"reason":""}', stderr: '', exitCode: 0 }),
    })
    await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(sup.getPushState('s1').count).toBe(1)
    sup.resetPushState('s1')
    expect(sup.getPushState('s1').count).toBe(0)
  })
})

describe('agent-supervisor / shouldSuppressStopPush()', () => {
  let db
  beforeEach(() => { db = openDb(':memory:') })

  function makeSupervisor({ enabled = true, activePushEnabled = true, maxConsecutive = 5, runCli } = {}) {
    return createAgentSupervisor({
      db,
      getConfig: () => ({
        tools: { claude: { command: 'claude', bin: '/usr/local/bin/claude', args: [] } },
        agentSupervisor: {
          enabled, tool: 'claude', model: '', timeoutMs: 60_000,
          threshold: 0.8, allowlist: ['allow'],
          permissionAuto: true, askUserAuto: true,
          activePush: { enabled: activePushEnabled, maxConsecutive, intervalMs: 60_000, maxTokensPerTodo: 500_000 },
          browserControl: {},
        },
      }),
      logger: { warn: () => {}, info: () => {} },
      runCli,
    })
  }

  it('returns false when globally disabled', () => {
    expect(makeSupervisor({ enabled: false }).shouldSuppressStopPush('s1')).toBe(false)
  })

  it('returns false when active push sub-toggle off', () => {
    expect(makeSupervisor({ activePushEnabled: false }).shouldSuppressStopPush('s1')).toBe(false)
  })

  it('returns true when budget remains', () => {
    expect(makeSupervisor().shouldSuppressStopPush('s1')).toBe(true)
  })

  it('returns false once max consecutive is hit', async () => {
    const sup = makeSupervisor({
      maxConsecutive: 1,
      runCli: async () => ({ stdout: '{"done":false,"needsHumanReview":false,"nextPrompt":"x","confidence":0.95,"reason":""}', stderr: '', exitCode: 0 }),
    })
    await sup.analyzeForPush({ sessionId: 's1', todoId: null, recentOutput: '' })
    expect(sup.shouldSuppressStopPush('s1')).toBe(false)
  })
})

describe('agent-supervisor / describe()', () => {
  it('returns tool + bin instead of API key info', () => {
    const db = openDb(':memory:')
    const sup = createAgentSupervisor({
      db,
      getConfig: () => ({
        tools: { claude: { command: 'claude', bin: '/usr/local/bin/claude', args: [] } },
        agentSupervisor: {
          enabled: true, tool: 'claude', model: 'claude-opus-4-7', timeoutMs: 45_000,
          threshold: 0.7, allowlist: ['allow'],
          permissionAuto: true, askUserAuto: false, activePush: {}, browserControl: {},
        },
      }),
    })
    const d = sup.describe()
    expect(d.enabled).toBe(true)
    expect(d.tool).toBe('claude')
    expect(d.bin).toBe('/usr/local/bin/claude')
    expect(d.model).toBe('claude-opus-4-7')
    expect(d.timeoutMs).toBe(45_000)
    expect(d.permissionAuto).toBe(true)
    expect(d.askUserAuto).toBe(false)
    // 没有 apiKey 相关字段
    expect(d.apiKey).toBeUndefined()
    expect(d.hasApiKey).toBeUndefined()
  })
})
