import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { createAgentSupervisor, __test__ } from '../src/agent-supervisor.js'

const { buildDecisionPayload, parseDecisionResponse, isOptionInAllowlist, maskKey } = __test__

describe('agent-supervisor / utilities', () => {
  it('isOptionInAllowlist matches case-insensitively and via includes', () => {
    expect(isOptionInAllowlist('Allow once', ['allow'])).toBe(true)
    expect(isOptionInAllowlist('Yes, do it', ['yes'])).toBe(true)
    expect(isOptionInAllowlist('Deny', ['allow', 'yes'])).toBe(false)
    expect(isOptionInAllowlist('', ['allow'])).toBe(false)
    expect(isOptionInAllowlist('Allow', [])).toBe(false)
  })

  it('maskKey hides middle of API key', () => {
    expect(maskKey('sk-ant-abcdef12345')).toBe('sk-a…2345')
    expect(maskKey('short')).toBe('***')
    expect(maskKey('')).toBe('')
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

  it('buildDecisionPayload includes context + options + JSON instructions', () => {
    const p = buildDecisionPayload({
      kind: 'permission',
      model: 'claude-opus-4-7',
      todoTitle: '部署服务',
      todoDescription: '提了 PR 之后部署上线',
      promptText: 'Do you want to run `git push`?',
      options: ['Allow', 'Allow once', 'Deny'],
      recentOutput: 'about to push',
    })
    expect(p.model).toBe('claude-opus-4-7')
    expect(p.messages).toHaveLength(1)
    const user = p.messages[0].content
    expect(user).toContain('部署服务')
    expect(user).toContain('Allow once')
    expect(user).toContain('严格 JSON')
    expect(p.system).toContain('守望者')
  })
})

describe('agent-supervisor / decide()', () => {
  let db
  beforeEach(() => {
    db = openDb(':memory:')
    db.createTodo?.({ id: 't1', title: '部署服务', description: '提 PR 之后上线', quadrant: 1 })
  })

  function makeSupervisor({ enabled = true, allowlist = ['allow', 'yes'], threshold = 0.8, model = 'claude-opus-4-7', apiKey = 'sk-test', fetchImpl, permissionAuto = true, askUserAuto = true } = {}) {
    return createAgentSupervisor({
      db,
      getConfig: () => ({
        agentSupervisor: {
          enabled, model, apiKey, apiBaseUrl: 'https://api.example.com',
          threshold, allowlist, permissionAuto, askUserAuto,
          activePush: {}, browserControl: {},
        },
      }),
      logger: { warn: () => {}, info: () => {} },
      fetchImpl,
    })
  }

  it('returns skipped when disabled and writes no audit', async () => {
    const sup = makeSupervisor({ enabled: false })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
    expect(r).toEqual({ status: 'skipped', reason: 'disabled' })
    expect(db.countAgentDecisions()).toBe(0)
  })

  it('returns auto when API returns confident in-allowlist choice', async () => {
    const sup = makeSupervisor({
      fetchImpl: async () => ({
        text: '{"choiceIndex":0,"choice":"Allow","confidence":0.95,"reason":"safe read"}',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'read file?', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('auto')
    expect(r.choice).toBe('Allow')
    expect(r.confidence).toBe(0.95)
    expect(db.countAgentDecisions()).toBe(1)
    const rows = db.listAgentDecisions({ limit: 10 })
    expect(rows[0].status).toBe('auto')
    expect(rows[0].tokensIn).toBe(10)
  })

  it('falls back when option not in allowlist', async () => {
    const sup = makeSupervisor({
      allowlist: ['allow'],
      fetchImpl: async () => ({
        text: '{"choiceIndex":1,"choice":"Deny","confidence":0.99,"reason":"danger"}',
        usage: {},
      }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'delete?', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('fallback')
    expect(r.reason).toBe('not_in_allowlist')
    expect(db.countAgentDecisions()).toBe(1)
    expect(db.listAgentDecisions({ limit: 1 })[0].status).toBe('fallback')
  })

  it('falls back when confidence below threshold', async () => {
    const sup = makeSupervisor({
      threshold: 0.9,
      fetchImpl: async () => ({
        text: '{"choiceIndex":0,"choice":"Allow","confidence":0.6,"reason":"maybe"}',
        usage: {},
      }),
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow', 'Deny'] })
    expect(r.status).toBe('fallback')
    expect(r.reason).toBe('below_threshold')
  })

  it('returns failed on API error and writes audit', async () => {
    const sup = makeSupervisor({
      fetchImpl: async () => { throw new Error('network down') },
    })
    const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
    expect(r.status).toBe('failed')
    expect(r.reason).toBe('network down')
    expect(db.countAgentDecisions()).toBe(1)
    expect(db.listAgentDecisions({ limit: 1 })[0].status).toBe('failed')
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

  it('returns failed when api key missing and globally enabled', async () => {
    const sup = createAgentSupervisor({
      db,
      getConfig: () => ({ agentSupervisor: { enabled: true, model: 'x', apiKey: '', apiBaseUrl: 'http://x', allowlist: ['allow'], threshold: 0.8, permissionAuto: true, askUserAuto: true, activePush: {}, browserControl: {} } }),
      logger: { warn: () => {}, info: () => {} },
    })
    // 干净环境：避免开发机 env ANTHROPIC_API_KEY 干扰
    const prev = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const r = await sup.decide({ kind: 'permission', sessionId: 's1', todoId: null, promptText: 'p', options: ['Allow'] })
      expect(r.status).toBe('failed')
      expect(r.reason).toBe('no_api_key')
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev
    }
  })
})

describe('agent-supervisor / describe()', () => {
  it('returns masked api key and other config', () => {
    const db = openDb(':memory:')
    const sup = createAgentSupervisor({
      db,
      getConfig: () => ({
        agentSupervisor: {
          enabled: true, model: 'claude-opus-4-7', apiKey: 'sk-ant-secret-token-12345',
          apiBaseUrl: 'https://api.example.com', threshold: 0.7, allowlist: ['allow'],
          permissionAuto: true, askUserAuto: false, activePush: {}, browserControl: {},
        },
      }),
    })
    const d = sup.describe()
    expect(d.hasApiKey).toBe(true)
    expect(d.apiKeyHint).toMatch(/^sk-a.+345$/)
    expect(d.model).toBe('claude-opus-4-7')
    expect(d.permissionAuto).toBe(true)
    expect(d.askUserAuto).toBe(false)
  })
})
