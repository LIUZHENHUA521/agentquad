// test/terminal-themes-presets.test.js
import { describe, it, expect } from 'vitest'
import {
  TERMINAL_PRESETS,
  PRESET_LABELS,
  PRESET_ORDER,
} from '../web/src/terminalThemes.ts'

const EXPECTED_KEYS = [
  'default',
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'catppuccin-latte',
  'tokyo-night-storm',
]

const REQUIRED_FIELDS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

const HEX_RE = /^#[0-9a-f]{6}$/i

describe('TERMINAL_PRESETS structure', () => {
  it('PRESET_ORDER 包含 6 个新 key 且顺序正确', () => {
    expect(PRESET_ORDER).toEqual(EXPECTED_KEYS)
  })

  it('每个 PRESET_ORDER 中的 key 都在 PRESET_LABELS 和 TERMINAL_PRESETS 中', () => {
    for (const key of PRESET_ORDER) {
      expect(PRESET_LABELS[key]).toBeTruthy()
      expect(TERMINAL_PRESETS[key]).toBeTruthy()
    }
  })

  it('每个 preset 拥有完整的 22 个色彩字段，且都是合法 hex', () => {
    for (const key of EXPECTED_KEYS) {
      const theme = TERMINAL_PRESETS[key]
      for (const field of REQUIRED_FIELDS) {
        expect(theme[field], `${key}.${field}`).toMatch(HEX_RE)
      }
    }
  })
})
