import { describe, expect, it } from 'vitest'
import { hasPermissionButtons, buildPermissionCard } from '../src/lark-card.js'

describe('lark-card.hasPermissionButtons', () => {
  it('returns true when any inline_keyboard button has qt:perm: callback_data', () => {
    expect(hasPermissionButtons({
      inline_keyboard: [[
        { text: 'Allow', callback_data: 'qt:perm:abcd:allow' },
        { text: 'Deny', callback_data: 'qt:perm:abcd:deny' },
      ]],
    })).toBe(true)
  })

  it('returns false for non-perm buttons', () => {
    expect(hasPermissionButtons({
      inline_keyboard: [[
        { text: 'Workdir 1', callback_data: 'qt:wd:0' },
      ]],
    })).toBe(false)
  })

  it('handles missing / malformed inputs', () => {
    expect(hasPermissionButtons(null)).toBe(false)
    expect(hasPermissionButtons({})).toBe(false)
    expect(hasPermissionButtons({ inline_keyboard: 'not-array' })).toBe(false)
    expect(hasPermissionButtons({ inline_keyboard: [null, [{}]] })).toBe(false)
  })
})

describe('lark-card.buildPermissionCard', () => {
  it('produces an interactive card with allow/deny buttons whose value carries the original callback_data', () => {
    const card = buildPermissionCard({
      message: 'Claude Code 想运行 git push origin main',
      replyMarkup: {
        inline_keyboard: [[
          { text: '允许（Enter）', callback_data: 'qt:perm:abcd:allow' },
          { text: '拒绝/退出（Esc）', callback_data: 'qt:perm:abcd:deny' },
        ]],
      },
    })

    expect(card.config).toEqual({ wide_screen_mode: true })
    expect(card.header.title.content).toContain('等待授权')
    expect(card.header.template).toBe('yellow')

    const div = card.elements.find((el) => el.tag === 'div')
    expect(div.text.content).toBe('Claude Code 想运行 git push origin main')

    const action = card.elements.find((el) => el.tag === 'action')
    expect(action.actions).toHaveLength(2)
    expect(action.actions[0]).toMatchObject({
      tag: 'button',
      type: 'primary',
      value: { callback_data: 'qt:perm:abcd:allow' },
    })
    expect(action.actions[0].text.content).toBe('允许（Enter）')
    expect(action.actions[1]).toMatchObject({
      tag: 'button',
      type: 'danger',
      value: { callback_data: 'qt:perm:abcd:deny' },
    })
  })

  it('clamps long bodies to 4000 chars', () => {
    const long = 'X'.repeat(5000)
    const card = buildPermissionCard({ message: long, replyMarkup: { inline_keyboard: [[{ text: 'OK', callback_data: 'qt:perm:abcd:allow' }]] } })
    const div = card.elements.find((el) => el.tag === 'div')
    expect(div.text.content.length).toBe(4000)
  })

  it('substitutes a placeholder when message is empty', () => {
    const card = buildPermissionCard({ message: '', replyMarkup: { inline_keyboard: [[{ text: 'OK', callback_data: 'qt:perm:abcd:allow' }]] } })
    const div = card.elements.find((el) => el.tag === 'div')
    expect(div.text.content).toBe('（无内容）')
  })
})
