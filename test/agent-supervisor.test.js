import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../src/db.js'
import { createAgentSupervisor, __test__ } from '../src/agent-supervisor.js'

const { buildDecisionPrompt, parseDecisionResponse, isOptionInAllowlist, buildSpawnArgs } = __test__

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
