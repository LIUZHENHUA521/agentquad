# Terminal Theme Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 web 终端的 5 个老旧内置主题（Quadtodo / Dracula / Solarized × 2 / One Dark）替换为 6 个现代审美的主题（重制 Quadtodo + Catppuccin 全家族 + Tokyo Night Storm），并对旧用户 localStorage 中的老 preset key 做静默迁移。

**Architecture:** 重写 `web/src/terminalThemes.ts` 中的预设常量；保持类型和工具函数（`isPresetName` / `deriveChrome` 等）原契约不变。新增纯函数 `migratePreset()` 和 `shouldPersistMigration()` 用于迁移逻辑，前者在 `readStored()` 中改写返回值（不写入），后者在 `useTerminalTheme()` 的一次性 `useEffect` 里触发持久化写入。

**Tech Stack:** TypeScript / React 18 / xterm.js / vitest（项目根目录 `test/*.test.{js,ts}`，import 形如 `'../web/src/...'`，node 环境）。

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `web/src/terminalThemes.ts` | Modify | 6 个内置预设常量、`TerminalPresetName` 类型、`PRESET_LABELS`、`PRESET_ORDER`、`LEGACY_PRESET_MIGRATION` 常量、`migratePreset()` 纯函数 |
| `web/src/hooks/useTerminalTheme.ts` | Modify | `readStored()` 中应用 `migratePreset()`；新增 `shouldPersistMigration()` 纯函数；在 hook 内增加一次性 `useEffect` 触发持久化 |
| `test/terminal-themes-chrome.test.js` | Modify | 把旧 preset 名替换为新 preset 名；放宽硬编码的 accent 期望以适配新主题集合 |
| `test/terminal-themes-presets.test.js` | Create | 结构性测试（6 个 key 都在、字段齐全、hex 合法）+ WCAG 对比度测试（fg/bg、cursor、selection 亮度差） |
| `test/terminal-themes-migration.test.js` | Create | `migratePreset()` 和 `shouldPersistMigration()` 两个纯函数的单元测试 |

DRY 提示：所有 hex 比较都用统一的 `/^#[0-9a-f]{6}$/i`；所有亮度/对比度计算共享一个 `parseHex` + `relLum` + `contrast` 工具组（参考 `test/terminal-themes-chrome.test.js` 已有实现，新 test 文件可直接复制一份相同实现，因为只是测试代码，无需提取共享模块）。

---

## Task 1: 写"6 个新预设存在 & 结构齐全"的失败测试（RED）

**Files:**
- Create: `test/terminal-themes-presets.test.js`

- [ ] **Step 1: 创建新 test 文件**

```js
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- terminal-themes-presets`
Expected: FAIL — PRESET_ORDER 仍含有旧 key（`dracula` 等），断言不匹配新 EXPECTED_KEYS

- [ ] **Step 3: Commit（仅测试）**

```bash
git add test/terminal-themes-presets.test.js
git commit -m "test(terminal-themes): add failing structural test for 6-preset refresh"
```

---

## Task 2: 用 6 个新预设替换 `terminalThemes.ts` 的预设常量（GREEN）

**Files:**
- Modify: `web/src/terminalThemes.ts:3-24`（替换 `TerminalPresetName` / `PRESET_LABELS` / `PRESET_ORDER`）
- Modify: `web/src/terminalThemes.ts:26-147`（替换 `TERMINAL_PRESETS` 字典）

- [ ] **Step 1: 替换 `TerminalPresetName` 联合类型**

把 `web/src/terminalThemes.ts:3-8` 改为：

```ts
export type TerminalPresetName =
  | 'default'
  | 'catppuccin-mocha'
  | 'catppuccin-macchiato'
  | 'catppuccin-frappe'
  | 'catppuccin-latte'
  | 'tokyo-night-storm'
```

- [ ] **Step 2: 替换 `PRESET_LABELS` 和 `PRESET_ORDER`**

把 `web/src/terminalThemes.ts:10-24` 改为：

```ts
export const PRESET_LABELS: Record<TerminalPresetName, string> = {
  'default': 'Quadtodo',
  'catppuccin-mocha': 'Catppuccin Mocha',
  'catppuccin-macchiato': 'Catppuccin Macchiato',
  'catppuccin-frappe': 'Catppuccin Frappé',
  'catppuccin-latte': 'Catppuccin Latte',
  'tokyo-night-storm': 'Tokyo Night Storm',
}

export const PRESET_ORDER: TerminalPresetName[] = [
  'default',
  'catppuccin-mocha',
  'catppuccin-macchiato',
  'catppuccin-frappe',
  'catppuccin-latte',
  'tokyo-night-storm',
]
```

- [ ] **Step 3: 替换 `TERMINAL_PRESETS` 字典**

把 `web/src/terminalThemes.ts:26-147` 整个 `TERMINAL_PRESETS` 对象（含所有 5 个旧 preset）替换为下面 6 个新 preset：

```ts
export const TERMINAL_PRESETS: Record<TerminalPresetName, ITheme> = {
  // Quadtodo (rebuilt): 保留品牌 background 与 cursor，ANSI 16 色向 Catppuccin Mocha 美学靠拢
  'default': {
    background: '#1a1a2e',
    foreground: '#e4e6f1',
    cursor: '#569cd6',
    cursorAccent: '#1a1a2e',
    selectionBackground: '#264f78',
    selectionForeground: '#ffffff',
    black: '#2a2a44',
    red: '#f06292',
    green: '#82d779',
    yellow: '#f1c987',
    blue: '#6da8f5',
    magenta: '#c084fc',
    cyan: '#5dd9c5',
    white: '#d6d8e8',
    brightBlack: '#4a4d72',
    brightRed: '#ff7aa6',
    brightGreen: '#9ce28f',
    brightYellow: '#ffd89b',
    brightBlue: '#88baff',
    brightMagenta: '#d5a3ff',
    brightCyan: '#7eebd7',
    brightWhite: '#ffffff',
  },
  // Catppuccin Mocha — github.com/catppuccin/catppuccin palette.json
  'catppuccin-mocha': {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
  // Catppuccin Macchiato
  'catppuccin-macchiato': {
    background: '#24273a',
    foreground: '#cad3f5',
    cursor: '#f4dbd6',
    cursorAccent: '#24273a',
    selectionBackground: '#5b6078',
    selectionForeground: '#cad3f5',
    black: '#494d64',
    red: '#ed8796',
    green: '#a6da95',
    yellow: '#eed49f',
    blue: '#8aadf4',
    magenta: '#f5bde6',
    cyan: '#8bd5ca',
    white: '#b8c0e0',
    brightBlack: '#5b6078',
    brightRed: '#ed8796',
    brightGreen: '#a6da95',
    brightYellow: '#eed49f',
    brightBlue: '#8aadf4',
    brightMagenta: '#f5bde6',
    brightCyan: '#8bd5ca',
    brightWhite: '#a5adcb',
  },
  // Catppuccin Frappé
  'catppuccin-frappe': {
    background: '#303446',
    foreground: '#c6d0f5',
    cursor: '#f2d5cf',
    cursorAccent: '#303446',
    selectionBackground: '#626880',
    selectionForeground: '#c6d0f5',
    black: '#51576d',
    red: '#e78284',
    green: '#a6d189',
    yellow: '#e5c890',
    blue: '#8caaee',
    magenta: '#f4b8e4',
    cyan: '#81c8be',
    white: '#b5bfe2',
    brightBlack: '#626880',
    brightRed: '#e78284',
    brightGreen: '#a6d189',
    brightYellow: '#e5c890',
    brightBlue: '#8caaee',
    brightMagenta: '#f4b8e4',
    brightCyan: '#81c8be',
    brightWhite: '#a5adce',
  },
  // Catppuccin Latte — 浅色；cursor 用 subtext1 覆盖官方 rosewater，确保对 light bg ≥ 3:1
  'catppuccin-latte': {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#5c5f77',
    cursorAccent: '#eff1f5',
    selectionBackground: '#acb0be',
    selectionForeground: '#4c4f69',
    black: '#bcc0cc',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#5c5f77',
    brightBlack: '#acb0be',
    brightRed: '#d20f39',
    brightGreen: '#40a02b',
    brightYellow: '#df8e1d',
    brightBlue: '#1e66f5',
    brightMagenta: '#ea76cb',
    brightCyan: '#179299',
    brightWhite: '#6c6f85',
  },
  // Tokyo Night Storm — github.com/folke/tokyonight.nvim/blob/main/lua/tokyonight/colors/storm.lua
  'tokyo-night-storm': {
    background: '#24283b',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    cursorAccent: '#24283b',
    selectionBackground: '#364a82',
    selectionForeground: '#c0caf5',
    black: '#1d202f',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
}
```

⚠ **不要动**文件后半部分的 `isValidColor` / `isPresetName` / `parseHexColor` / `mixRgb` / `lightenHex` / `darkenHex` / `relativeLuminance` / `contrastRatio` / `CHROME_FALLBACK` / `deriveChrome` — 这些与新预设兼容，保持原样。

- [ ] **Step 4: 运行 Task 1 的测试，确认通过**

Run: `npm test -- terminal-themes-presets`
Expected: PASS（3 个 it 全部通过）

- [ ] **Step 5: Commit**

```bash
git add web/src/terminalThemes.ts
git commit -m "refactor(terminal-themes): replace 5 legacy presets with 6 modern themes"
```

---

## Task 3: 修旧 chrome 测试，把旧 preset 名换成新 preset 名（GREEN）

**Files:**
- Modify: `test/terminal-themes-chrome.test.js`

旧测试硬编码了 `'dracula' / 'solarized-dark' / 'one-dark' / 'solarized-light'` 等已被删除的 key。需要：
- 把循环里的 key 列表换成新 6 个 key（或直接 `import PRESET_ORDER` 使用）
- 把 `expect(...solarized-light...).accent).toBe('#155b9b')` 改为 Latte 版本
- 把 `expect(...dracula...).accent).toBe('#7cc1ff')` 改为某个会触发 #7cc1ff 降级的新 dark 主题（`catppuccin-frappe` 经预计算确认会降级）

- [ ] **Step 1: 把整个文件改写为：**

```js
import { describe, it, expect } from 'vitest'
import {
  deriveChrome,
  TERMINAL_PRESETS,
  PRESET_ORDER,
} from '../web/src/terminalThemes.ts'

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const v = m[1]
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ]
}

function relLum([r, g, b]) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const la = relLum(parseHex(a)) + 0.05
  const lb = relLum(parseHex(b)) + 0.05
  return la > lb ? la / lb : lb / la
}

describe('deriveChrome', () => {
  it('深色主题：surface 比 background 更亮（raised）', () => {
    const dark = TERMINAL_PRESETS['default']
    const c = deriveChrome(dark)
    expect(c.isLight).toBe(false)
    expect(relLum(parseHex(c.surface))).toBeGreaterThan(relLum(parseHex(dark.background)))
    expect(relLum(parseHex(c.border))).toBeGreaterThan(relLum(parseHex(c.surface)))
  })

  it('浅色主题：surface 比 background 更暗（sunken）', () => {
    const light = TERMINAL_PRESETS['catppuccin-latte']
    const c = deriveChrome(light)
    expect(c.isLight).toBe(true)
    expect(relLum(parseHex(c.surface))).toBeLessThan(relLum(parseHex(light.background)))
    expect(relLum(parseHex(c.border))).toBeLessThan(relLum(parseHex(c.surface)))
  })

  it('outer 颜色直接采用 background，避免与内容区出现双层夹色', () => {
    for (const name of PRESET_ORDER) {
      const t = TERMINAL_PRESETS[name]
      expect(deriveChrome(t).outer.toLowerCase()).toBe(t.background.toLowerCase())
    }
  })

  it('mutedText 对 surface 的对比度足够区分但不抢眼（≥ 2.0）', () => {
    for (const name of PRESET_ORDER) {
      const c = deriveChrome(TERMINAL_PRESETS[name])
      expect(contrast(c.mutedText, c.surface), `${name} mutedText vs surface`)
        .toBeGreaterThanOrEqual(2.0)
    }
  })

  it('accent 对所选 surface 满足对比度 ≥ 4.5；不满足时降级到 fallback', () => {
    for (const name of PRESET_ORDER) {
      const c = deriveChrome(TERMINAL_PRESETS[name])
      expect(contrast(c.accent, c.surface), `${name} accent vs surface`)
        .toBeGreaterThanOrEqual(4.5)
    }
    // 浅色 Latte 应触发 accent 降级到深蓝
    expect(deriveChrome(TERMINAL_PRESETS['catppuccin-latte']).accent).toBe('#155b9b')
    // 默认 quadtodo 深色 + 高饱和品牌蓝对比度足够，保留品牌蓝
    expect(deriveChrome(TERMINAL_PRESETS['default']).accent).toBe('#569cd6')
    // 中等深的 Frappé surface 不够暗，应切到更亮的蓝
    expect(deriveChrome(TERMINAL_PRESETS['catppuccin-frappe']).accent).toBe('#7cc1ff')
  })

  it('用户自定义主题（仅 background/foreground）也能产出有效 chrome', () => {
    const custom = { background: '#fafafa', foreground: '#222222' }
    const c = deriveChrome(custom)
    expect(c.isLight).toBe(true)
    expect(c.outer).toBe('#fafafa')
    expect(/^#[0-9a-f]{6}$/i.test(c.surface)).toBe(true)
    expect(/^#[0-9a-f]{6}$/i.test(c.border)).toBe(true)
    expect(/^#[0-9a-f]{6}$/i.test(c.mutedText)).toBe(true)
  })

  it('background / foreground 非合法 hex 时退化为稳定的深色 fallback', () => {
    const c = deriveChrome({ background: 'rgb(0,0,0)', foreground: 'red' })
    expect(c.outer).toBe('#1a1a2e')
    expect(c.surface).toBe('#16213e')
    expect(c.isLight).toBe(false)
  })
})
```

- [ ] **Step 2: 运行此文件，确认通过**

Run: `npm test -- terminal-themes-chrome`
Expected: PASS（7 个 it 全部通过）

- [ ] **Step 3: 运行全量测试，确认无回归**

Run: `npm test`
Expected: 整套测试 PASS

- [ ] **Step 4: Commit**

```bash
git add test/terminal-themes-chrome.test.js
git commit -m "test(terminal-themes): retarget chrome tests to new 6-preset set"
```

---

## Task 4: 增补 WCAG 对比度测试（GREEN，覆盖 6 个主题）

**Files:**
- Modify: `test/terminal-themes-presets.test.js`

补充验证 spec 的验收 #2-#4：fg/bg 对比度、cursor 对比度、selection 亮度差。

- [ ] **Step 1: 在 `test/terminal-themes-presets.test.js` 文件**末尾追加：

```js
function parseHex(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return null
  const v = m[1]
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ]
}

function relLum([r, g, b]) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a, b) {
  const la = relLum(parseHex(a)) + 0.05
  const lb = relLum(parseHex(b)) + 0.05
  return la > lb ? la / lb : lb / la
}

describe('TERMINAL_PRESETS WCAG contrast', () => {
  it('每个主题的 foreground 对 background 对比度 ≥ 4.5（WCAG AA）', () => {
    for (const key of EXPECTED_KEYS) {
      const t = TERMINAL_PRESETS[key]
      expect(contrast(t.foreground, t.background), `${key} fg/bg`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

  it('default（Quadtodo）作为默认主题要求 fg/bg 对比度 ≥ 7（WCAG AAA）', () => {
    const t = TERMINAL_PRESETS['default']
    expect(contrast(t.foreground, t.background)).toBeGreaterThanOrEqual(7)
  })

  it('每个主题的 cursor 对 background 对比度 ≥ 3', () => {
    for (const key of EXPECTED_KEYS) {
      const t = TERMINAL_PRESETS[key]
      expect(contrast(t.cursor, t.background), `${key} cursor/bg`)
        .toBeGreaterThanOrEqual(3)
    }
  })

  it('每个主题的 selectionBackground 与 background 相对亮度绝对差 ≥ 0.05（选区可见）', () => {
    for (const key of EXPECTED_KEYS) {
      const t = TERMINAL_PRESETS[key]
      const dl = Math.abs(relLum(parseHex(t.background)) - relLum(parseHex(t.selectionBackground)))
      expect(dl, `${key} selection luminance delta`).toBeGreaterThanOrEqual(0.05)
    }
  })
})
```

- [ ] **Step 2: 运行测试，确认全部通过**

Run: `npm test -- terminal-themes-presets`
Expected: PASS（结构测试 3 个 + 对比度测试 4 个 = 7 个 it）

如果任何 it 失败：检查 spec 中对应主题字段是否被错抄；不要为了让测试通过随意降低阈值。失败 = palette 选错了，回头修 `terminalThemes.ts`。

- [ ] **Step 3: Commit**

```bash
git add test/terminal-themes-presets.test.js
git commit -m "test(terminal-themes): add WCAG contrast checks for 6 presets"
```

---

## Task 5: 写 `migratePreset()` 失败测试（RED）

**Files:**
- Create: `test/terminal-themes-migration.test.js`

- [ ] **Step 1: 创建 test 文件**

```js
// test/terminal-themes-migration.test.js
import { describe, it, expect } from 'vitest'
import {
  migratePreset,
  LEGACY_PRESET_MIGRATION,
} from '../web/src/terminalThemes.ts'

describe('migratePreset', () => {
  it('dracula → catppuccin-mocha', () => {
    expect(migratePreset('dracula')).toEqual({ value: 'catppuccin-mocha', migrated: true })
  })

  it('solarized-dark → catppuccin-macchiato', () => {
    expect(migratePreset('solarized-dark')).toEqual({ value: 'catppuccin-macchiato', migrated: true })
  })

  it('one-dark → tokyo-night-storm', () => {
    expect(migratePreset('one-dark')).toEqual({ value: 'tokyo-night-storm', migrated: true })
  })

  it('solarized-light → catppuccin-latte', () => {
    expect(migratePreset('solarized-light')).toEqual({ value: 'catppuccin-latte', migrated: true })
  })

  it('已是新 key 时不迁移', () => {
    expect(migratePreset('catppuccin-mocha')).toEqual({ value: 'catppuccin-mocha', migrated: false })
    expect(migratePreset('default')).toEqual({ value: 'default', migrated: false })
  })

  it('custom: 前缀的自定义主题不被迁移', () => {
    expect(migratePreset('custom:my-theme')).toEqual({ value: 'custom:my-theme', migrated: false })
  })

  it('未知 key 原样返回（由后续 isPresetName 兜底回退到 default）', () => {
    expect(migratePreset('unknown-theme-xyz')).toEqual({ value: 'unknown-theme-xyz', migrated: false })
  })

  it('LEGACY_PRESET_MIGRATION 涵盖全部 4 个老 preset', () => {
    expect(Object.keys(LEGACY_PRESET_MIGRATION).sort()).toEqual(
      ['dracula', 'one-dark', 'solarized-dark', 'solarized-light']
    )
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- terminal-themes-migration`
Expected: FAIL — `migratePreset` 和 `LEGACY_PRESET_MIGRATION` 还没从 `terminalThemes.ts` 导出

- [ ] **Step 3: Commit（仅测试）**

```bash
git add test/terminal-themes-migration.test.js
git commit -m "test(terminal-themes): add failing migration tests for legacy presets"
```

---

## Task 6: 实现 `migratePreset()` 纯函数 + 接入 `readStored()`（GREEN）

**Files:**
- Modify: `web/src/terminalThemes.ts`（在 `isPresetName` 之后追加导出）
- Modify: `web/src/hooks/useTerminalTheme.ts:29-46`（在 `readStored` 内应用迁移）

- [ ] **Step 1: 在 `web/src/terminalThemes.ts` 文件中，紧接 `isPresetName` 函数之后追加**

```ts
/** 旧版本内置 preset → 新版本对应主题。仅在 readStored 中改写返回值；持久化由 hook 的 useEffect 完成。 */
export const LEGACY_PRESET_MIGRATION: Record<string, TerminalPresetName> = {
  'dracula': 'catppuccin-mocha',
  'solarized-dark': 'catppuccin-macchiato',
  'one-dark': 'tokyo-night-storm',
  'solarized-light': 'catppuccin-latte',
}

/** 纯函数：把旧 preset key 映射到新 key；非 legacy 输入原样返回。 */
export function migratePreset(raw: string): { value: string; migrated: boolean } {
  const mapped = LEGACY_PRESET_MIGRATION[raw]
  if (mapped) return { value: mapped, migrated: true }
  return { value: raw, migrated: false }
}
```

- [ ] **Step 2: 修改 `web/src/hooks/useTerminalTheme.ts`**

在文件顶部导入新增的 `migratePreset`：

把 `web/src/hooks/useTerminalTheme.ts:3-8` 改为：

```ts
import {
  TERMINAL_PRESETS,
  TerminalPresetName,
  isPresetName,
  isValidColor,
  migratePreset,
} from '../terminalThemes'
```

然后修改 `readStored()` 中解析 `presetCandidate` 的部分。把 `web/src/hooks/useTerminalTheme.ts:29-46` 改为：

```ts
function readStored(): StoredTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STORED
    const parsed = JSON.parse(raw)
    const presetCandidateRaw: string = typeof parsed?.preset === 'string' ? parsed.preset : 'default'
    const presetCandidate = migratePreset(presetCandidateRaw).value
    const preset = (isPresetName(presetCandidate) || presetCandidate.startsWith(CUSTOM_PREFIX))
      ? presetCandidate : 'default'
    const override: ThemeOverride = {}
    if (parsed?.override && typeof parsed.override === 'object') {
      if (isValidColor(parsed.override.background)) override.background = parsed.override.background
      if (isValidColor(parsed.override.foreground)) override.foreground = parsed.override.foreground
    }
    return { preset, override }
  } catch {
    return DEFAULT_STORED
  }
}
```

- [ ] **Step 3: 运行 Task 5 测试，确认通过**

Run: `npm test -- terminal-themes-migration`
Expected: PASS（8 个 it 全部通过）

- [ ] **Step 4: 运行全量测试**

Run: `npm test`
Expected: 整套测试 PASS（包括之前的 `terminal-themes-chrome`、`terminal-themes-presets`）

- [ ] **Step 5: Commit**

```bash
git add web/src/terminalThemes.ts web/src/hooks/useTerminalTheme.ts
git commit -m "feat(terminal-themes): migrate legacy preset names to new themes"
```

---

## Task 7: 写 `shouldPersistMigration()` 失败测试（RED）

**Files:**
- Modify: `test/terminal-themes-migration.test.js`（追加 describe 块）

`shouldPersistMigration` 判断 localStorage 的 raw 字符串是否需要被持久化迁移；返回需要写回的 StoredTheme 或 null。它是 useEffect 调用的纯函数核心。

- [ ] **Step 1: 在 `test/terminal-themes-migration.test.js` 末尾追加**

```js
import { shouldPersistMigration } from '../web/src/hooks/useTerminalTheme.ts'

describe('shouldPersistMigration', () => {
  it('raw = null（无存储）→ 返回 null，不需要写回', () => {
    expect(shouldPersistMigration(null)).toBeNull()
  })

  it('raw = "" → 返回 null', () => {
    expect(shouldPersistMigration('')).toBeNull()
  })

  it('非法 JSON → 返回 null', () => {
    expect(shouldPersistMigration('{not-json}')).toBeNull()
  })

  it('preset 已是新 key → 返回 null（不需要写回）', () => {
    const raw = JSON.stringify({ preset: 'catppuccin-mocha', override: {} })
    expect(shouldPersistMigration(raw)).toBeNull()
  })

  it('preset = "dracula" → 返回 { preset: "catppuccin-mocha", override: {} }', () => {
    const raw = JSON.stringify({ preset: 'dracula', override: {} })
    expect(shouldPersistMigration(raw)).toEqual({
      preset: 'catppuccin-mocha',
      override: {},
    })
  })

  it('迁移时保留 override 字段', () => {
    const raw = JSON.stringify({
      preset: 'one-dark',
      override: { background: '#123456' },
    })
    expect(shouldPersistMigration(raw)).toEqual({
      preset: 'tokyo-night-storm',
      override: { background: '#123456' },
    })
  })

  it('preset 字段缺失 → 返回 null', () => {
    const raw = JSON.stringify({ override: {} })
    expect(shouldPersistMigration(raw)).toBeNull()
  })

  it('custom: 前缀 → 返回 null（不需要迁移）', () => {
    const raw = JSON.stringify({ preset: 'custom:my-theme', override: {} })
    expect(shouldPersistMigration(raw)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- terminal-themes-migration`
Expected: FAIL — `shouldPersistMigration` 还未从 `useTerminalTheme.ts` 导出

- [ ] **Step 3: Commit（仅测试）**

```bash
git add test/terminal-themes-migration.test.js
git commit -m "test(terminal-themes): add failing tests for shouldPersistMigration"
```

---

## Task 8: 实现 `shouldPersistMigration()` 并在 hook 中接入 useEffect（GREEN）

**Files:**
- Modify: `web/src/hooks/useTerminalTheme.ts`

- [ ] **Step 1: 在 `useTerminalTheme.ts` 中导入 `useEffect`**

把文件顶部的 `import { useCallback, useSyncExternalStore } from 'react'` 改为：

```ts
import { useCallback, useEffect, useSyncExternalStore } from 'react'
```

- [ ] **Step 2: 在 `readCustomPresets()` 之后、`writeStored()` 之前追加 `shouldPersistMigration()`**

```ts
/**
 * 纯函数：判断 localStorage 原始字符串是否携带需要迁移的旧 preset。
 * 返回需要写回的 StoredTheme；如果不需要写回（值非法 / 已是新 key / 没有 preset 字段），返回 null。
 */
export function shouldPersistMigration(rawStored: string | null): StoredTheme | null {
  if (!rawStored) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawStored)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rawPreset = (parsed as { preset?: unknown }).preset
  if (typeof rawPreset !== 'string') return null
  const { value, migrated } = migratePreset(rawPreset)
  if (!migrated) return null
  const rawOverride = (parsed as { override?: unknown }).override
  const override: ThemeOverride = {}
  if (rawOverride && typeof rawOverride === 'object') {
    const o = rawOverride as ThemeOverride
    if (isValidColor(o.background)) override.background = o.background
    if (isValidColor(o.foreground)) override.foreground = o.foreground
  }
  return { preset: value, override }
}
```

- [ ] **Step 3: 在 `useTerminalTheme()` 内的 `useSyncExternalStore` 调用之后、`setPreset` 之前，新增一次性 `useEffect`**

```ts
  // 一次性持久化：把旧 preset key 替换为新 key（spec 验收 #6）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const next = shouldPersistMigration(raw)
      if (next) writeStored(next)
    } catch { /* ignore */ }
  }, [])
```

- [ ] **Step 4: 运行 Task 7 测试，确认通过**

Run: `npm test -- terminal-themes-migration`
Expected: PASS（migratePreset 8 个 + shouldPersistMigration 8 个 = 16 个 it）

- [ ] **Step 5: 运行全量测试**

Run: `npm test`
Expected: 整套测试 PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/useTerminalTheme.ts
git commit -m "feat(terminal-themes): persist legacy preset migration on hook mount"
```

---

## Task 9: TypeScript 全量检查 + 浏览器视觉验证

**Files:**（不改文件，仅验证）

- [ ] **Step 1: 在 `web/` 子目录跑 tsc**

Run: `cd web && npm run build`
Expected: 构建成功，无 TS 错误。重点确认：
- `TerminalPresetName` 类型变化没破坏 `AiTerminalMini.tsx` 中 `PRESET_ORDER.map((name) => ...)` 的类型推断
- `useTerminalTheme.ts` 的 `__internal` 不再导出 `readStored/writeStored` 是否可能被外部引用（grep 一下）

```bash
grep -rn "__internal\|readStored\|writeStored" /Users/bytedance/Desktop/code/quadtodo/web/src 2>/dev/null | grep -v useTerminalTheme.ts | grep -v terminalThemes.ts
```

Expected: 无外部引用；如果有，按需处理。

- [ ] **Step 2: 跑 dev server**

Run: `cd web && npm run dev`
打开浏览器到 dev 地址，找到 AI Terminal Mini 工具栏的"主题"下拉。

- [ ] **Step 3: 视觉验证（逐主题切换，每个主题确认 3 项）**

对 6 个主题（Quadtodo / Catppuccin Mocha / Macchiato / Frappé / Latte / Tokyo Night Storm）逐个点选，每次切换后确认：
1. 终端正文区背景色、字体色、光标与预期一致
2. AI Markdown 渲染区可读、无错位
3. 下拉里 6 个色块肉眼可区分（特别检查 Mocha vs Macchiato 和 Mocha vs Tokyo Night）

如果两个深色主题色块过于相似难以区分，记录但本次不处理（spec 风险表已列出，留作下一步讨论）。

- [ ] **Step 4: 旧用户迁移验证（手动）**

在浏览器开发者工具 Console 里执行：

```js
localStorage.setItem('quadtodo.terminalTheme', JSON.stringify({ preset: 'dracula', override: {} }))
location.reload()
```

刷新后：
- 主题下拉应显示 "Catppuccin Mocha"
- 再次检查 localStorage 应已变成 `{"preset":"catppuccin-mocha","override":{}}`

对剩余 3 个 legacy key（`solarized-dark` / `one-dark` / `solarized-light`）重复同样流程，确认分别落到 `catppuccin-macchiato` / `tokyo-night-storm` / `catppuccin-latte`。

- [ ] **Step 5: 自定义主题不受影响验证**

```js
localStorage.setItem('quadtodo.terminalTheme', JSON.stringify({ preset: 'custom:test', override: {} }))
location.reload()
```

刷新后下拉应显示 `test`（若已有同名 custom）或回退到 `default`（若没有），但 localStorage 中 `preset` 字段保持 `custom:test` 不变（不被误改）。

- [ ] **Step 6: 完成总结性 commit（如有遗留小修）**

如果上面验证过程中改了任何代码，单独 commit；如果没改，跳过。

```bash
git status
# 如果有 dirty
git add <files>
git commit -m "fix(terminal-themes): <短描述>"
```

- [ ] **Step 7: 报告完成**

最后向用户报告：
- 6 个主题对应的对比度数值表（fg/bg）
- 4 条 legacy key 迁移验证结果
- 任何视觉上发现的小问题（如某主题某种程度难区分）

---

## 完成判据

- ✅ `npm test` 全量通过
- ✅ `cd web && npm run build` 通过
- ✅ 6 个主题在浏览器中逐一切换正常
- ✅ 4 条 legacy key 都能正确迁移并持久化
- ✅ Custom 主题流程不受影响
