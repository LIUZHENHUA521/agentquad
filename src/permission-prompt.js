/**
 * 从 PTY 尾部抽出 Claude Code / Codex 的"授权弹窗"文本与候选选项。
 *
 * 输入 raw：session.recentOutput（≤ 4000 chars，含 ANSI + box-drawing 噪声），
 *           或 codex-prompt-detector 已经 ANSI-strip 过的短串。
 * 输出 { text, options }：
 *   - text: 清洗后的尾部多行字符串，给前端 PermissionCard 直接渲染。
 *   - options: 形如 [{ index: 1, label: 'Yes' }, ...]，按 index 升序；
 *              Codex 的 [Y/n] 类无枚举选项时返回 []。
 *
 * 设计：和 openclaw-hook.js 里给 IM 推送用的清洗管线职责相似，但目标是"短而干净"——
 * IM 那边会保留整轮 transcript，这里只要授权弹窗的尾巴几行，所以独立一个小模块，
 * 避免把 hook 私有 helper 改造成公共依赖。
 */

const ANSI_OSC = /\x1b\][^\x07]*(\x07|\x1b\\)/g
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z~]/g
const ANSI_OTHER = /\x1b[()#][A-Za-z0-9]|\x1b[>=<cDEHMNOPZ78]/g
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g

const BOX_HORIZONTAL = /[─━┄┅┈┉═]/g
const BOX_VERTICAL = /[│┃┆┇┊┋║]/g
const BOX_CORNERS = /[┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛╭╮╯╰╓╒╕╖╙╘╛╜╔╗╚╝]/g
const BOX_TEES = /[├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╠╣╦╩╬]/g

function stripAnsi(s) {
  return String(s || '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_OTHER, '')
    .replace(CTRL, '')
}

function stripBoxDrawing(s) {
  return String(s || '')
    .replace(BOX_HORIZONTAL, '')
    .replace(BOX_VERTICAL, '')
    .replace(BOX_CORNERS, '')
    .replace(BOX_TEES, '')
}

function compactBlankLines(s) {
  return String(s || '').replace(/\n[ \t]*\n+/g, '\n\n')
}

export function cleanPtyTail(raw) {
  if (!raw) return ''
  const noAnsi = stripAnsi(raw)
  const noBox = stripBoxDrawing(noAnsi)
  const lines = noBox.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  // 丢弃只剩 border 字符 / "❯" 指示符 的装饰行
  const filtered = lines.filter((l) => {
    const t = l.trim()
    if (!t) return true
    if (/^[\-=_|+~]+$/.test(t)) return false
    if (/^[❯>]+$/.test(t)) return false
    return true
  })
  // 行首单独 "❯ " / "> " 标记 → 删掉，但保留行内容（Claude TUI 用它指当前高亮选项）
  const stripped = filtered.map((l) => l.replace(/^(\s*)(?:❯|>)\s+/, '$1'))
  return compactBlankLines(stripped.join('\n')).trim()
}

/**
 * 在清洗后的文本里找形如 "1. Yes" / "2. No, suggest changes" 的枚举选项。
 * Claude Code 的 permission TUI 用 1-9 标号；Codex 一般没有这种枚举。
 *
 * 找不到 → []。重复 index 仅保留首条。label 截断到 80 字符。
 */
export function parsePermissionOptions(cleaned) {
  if (!cleaned) return []
  const seen = new Map()
  for (const l of cleaned.split('\n')) {
    const m = l.match(/^\s*([1-9])\.\s+(\S.{0,79}?)\s*$/)
    if (!m) continue
    const idx = parseInt(m[1], 10)
    const label = m[2].trim()
    if (!label) continue
    if (!seen.has(idx)) seen.set(idx, label)
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, label]) => ({ index, label }))
}

/**
 * 从 raw（PTY tail 或 detector 短串）提取最多 maxLines 行作为 prompt 文本，
 * 同时解析枚举选项。caller 已经清洗过也无害——cleanPtyTail 是幂等的。
 */
export function extractPermissionPrompt(raw, { maxLines = 20, maxChars = 800 } = {}) {
  const cleaned = cleanPtyTail(raw)
  if (!cleaned) return { text: '', options: [] }
  const lines = cleaned.split('\n')
  const tail = lines.slice(-maxLines).join('\n')
  const text = tail.length > maxChars ? tail.slice(-maxChars) : tail
  const options = parsePermissionOptions(text)
  return { text, options }
}
