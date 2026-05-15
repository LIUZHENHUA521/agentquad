import { describe, it, expect } from 'vitest'
import { normalizeConfig } from '../src/config.js'

describe('lark auto-create config', () => {
  it('DEFAULT_LARK_CONFIG sets autoCreateTodo to true', () => {
    const cfg = normalizeConfig({})
    expect(cfg.lark.autoCreateTodo).toBe(true)
  })

  it('user can opt out via explicit false', () => {
    const cfg = normalizeConfig({ lark: { autoCreateTodo: false } })
    expect(cfg.lark.autoCreateTodo).toBe(false)
  })

  it('any truthy value normalizes to retained', () => {
    const cfg = normalizeConfig({ lark: { autoCreateTodo: true } })
    expect(cfg.lark.autoCreateTodo).toBe(true)
  })
})
