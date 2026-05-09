/**
 * 把 telegram 风格的 replyMarkup（inline_keyboard）转成飞书 interactive card。
 * 主要用途：openclaw-hook 给 Claude Code 权限提示发的「允许/拒绝」按钮，
 * 在 lark 渠道改用飞书原生卡片，回调 value 仍带 'qt:perm:<short>:allow|deny' callback_data
 * 让 wizard.handlePermissionCallback 复用现成路径。
 */

const PERM_CALLBACK_PREFIX = 'qt:perm:'

/**
 * @returns {boolean} replyMarkup 是否带权限按钮（callback_data 以 qt:perm: 开头）
 */
export function hasPermissionButtons(replyMarkup) {
  const rows = replyMarkup?.inline_keyboard
  if (!Array.isArray(rows)) return false
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const btn of row) {
      const cd = btn?.callback_data
      if (typeof cd === 'string' && cd.startsWith(PERM_CALLBACK_PREFIX)) return true
    }
  }
  return false
}

function pickButtonTone(callbackData) {
  if (callbackData.endsWith(':allow')) return 'primary'
  if (callbackData.endsWith(':deny')) return 'danger'
  return 'default'
}

/**
 * 构造飞书 interactive card：黄色 header + 文本 div + 按钮 action。
 * 输入参数 message / replyMarkup 来自 openclaw-bridge.postText 的现有形参，
 * 不需要 hook 改动。
 */
export function buildPermissionCard({ message, replyMarkup, headerTitle = '⚠️ Claude Code 等待授权' } = {}) {
  const buttons = []
  const rows = replyMarkup?.inline_keyboard || []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const btn of row) {
      const cd = btn?.callback_data
      if (typeof cd !== 'string') continue
      buttons.push({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: String(btn.text || cd).slice(0, 64),
        },
        type: pickButtonTone(cd),
        value: { callback_data: cd },
      })
    }
  }
  // 飞书消息卡片 body 上限较大，但先给 4000 字裁剪兜底
  const bodyContent = String(message || '').slice(0, 4000) || '（无内容）'
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: headerTitle },
      template: 'yellow',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: bodyContent } },
      { tag: 'action', actions: buttons },
    ],
  }
}
