// Conversation 输入框（composer）的本地草稿持久化。
//
// 为什么独立成文件：草稿 key 是 per (todoId, sessionId)，但"恢复会话"会把 sessionId 换成新的
// （AiTerminalMini.tryAutoRecover / TranscriptView.resumeSession 两处都会换），如果不迁移
// 旧 key 下的草稿，恢复后用户的输入就被冲掉了。所以 helper 需要在 TranscriptView 和
// AiTerminalMini 两个组件之间共享。
//
// 存储格式：localStorage[`quadtodo.composer.{todoId}.{sessionId}`] = JSON.stringify({
//   text,        // composer 文本（含 [Image #N] 占位符）
//   images,      // [{ placeholder, path }] 后端永久上传文件路径 ~/.agentquad/web-uploads/
//   counter,     // imageCounterRef 当前值，避免恢复后下一张图编号撞车
// })
//
// 后端 ~/.agentquad/web-uploads/ 是永久文件（src/routes/uploads.js），所以保存绝对路径即可。

const DRAFT_KEY_PREFIX = 'quadtodo.composer.'
const DRAFT_MAX_BYTES = 100 * 1024  // 单条草稿上限：防 quota 异常 / 误粘大文本

export type DraftEntry = {
  text: string
  images: Array<{ placeholder: string; path: string }>
  counter: number
}

function draftKey(todoId: string, sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${todoId}.${sessionId}`
}

export function readDraft(todoId: string, sessionId: string): DraftEntry | null {
  try {
    const raw = localStorage.getItem(draftKey(todoId, sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.text !== 'string') return null
    const images = Array.isArray(parsed.images)
      ? parsed.images.filter((x: any) => x && typeof x.placeholder === 'string' && typeof x.path === 'string')
      : []
    const counter = Number.isFinite(parsed.counter) ? Number(parsed.counter) : 0
    return { text: parsed.text, images, counter }
  } catch { return null }
}

export function writeDraft(todoId: string, sessionId: string, entry: DraftEntry): void {
  try {
    if (!entry.text && entry.images.length === 0) {
      localStorage.removeItem(draftKey(todoId, sessionId))
      return
    }
    // 文本超长则截断尾部，保留前缀；图片映射全保留（每条不过百字节）
    const text = entry.text.length > DRAFT_MAX_BYTES ? entry.text.slice(0, DRAFT_MAX_BYTES) : entry.text
    localStorage.setItem(draftKey(todoId, sessionId), JSON.stringify({ ...entry, text }))
  } catch { /* quota exceeded 等：静默丢弃，不影响输入 */ }
}

export function clearDraft(todoId: string, sessionId: string): void {
  try { localStorage.removeItem(draftKey(todoId, sessionId)) } catch { /* ignore */ }
}

// 把旧 sessionId 下的草稿搬到新 sessionId 下。"恢复会话"会换 sessionId，
// 不搬的话用户在旧会话里写的草稿会随着 session-switch effect 一起清掉。
//
// 如果旧 key 没草稿，no-op；如果新 key 已有草稿（极少见，比如手动操作 localStorage），
// 不覆盖，避免吞掉用户在新 session 已经写好的内容。
export function migrateDraft(todoId: string, fromSessionId: string, toSessionId: string): void {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return
  const old = readDraft(todoId, fromSessionId)
  if (!old || (!old.text && old.images.length === 0)) return
  const existing = readDraft(todoId, toSessionId)
  if (existing && (existing.text || existing.images.length > 0)) return
  writeDraft(todoId, toSessionId, old)
  clearDraft(todoId, fromSessionId)
}
